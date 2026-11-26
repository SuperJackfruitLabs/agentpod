// Package benchremote is the remote-v1 launch on the bench host's node: the
// station's agent works in the card's bench from its own node, over SSH, with
// a short-lived certificate this node asks benchd for. The node holds the
// card's lease the whole time; the lease token never leaves it.
//
// Prepare leases and checkpoints the bench as the registered launch does, and
// binds no run. Attach issues (and, called again with the same key, renews) a
// writer certificate for the agent's public key. Finish checkpoints the work,
// stops and releases the lease, and completes with the remote execution and
// the agent's report. A dirty tree refuses the finish and keeps the lease, so
// the agent can commit and finish again.
package benchremote

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcanonical"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// Mode is the registry profile value that selects this launch.
const Mode = "remote-v1"

// Capability is what a node advertises when it can serve Mode: it issues
// remote bench credentials for the leases it holds.
const Capability = "bench.remote.credential"

// MaxPublicKey bounds the agent's public key line.
const MaxPublicKey = 8192

// MaxHandoff bounds the report's handoff, in canonical bytes.
const MaxHandoff = 32 << 10

// dirtyMessage is how SuperBench begins the one checkpoint conflict the agent
// can fix in its tree: uncommitted or untracked files.
const dirtyMessage = "workspace has uncommitted or untracked files"

var hex32 = regexp.MustCompile(`^[a-f0-9]{32}$`)

type Coordinator struct {
	Journal  Journal
	Producer benchlaunch.Producer
	// Client asks benchd for writer certificates and its remote executions.
	Client       *benchworkspace.Client
	Repositories []benchworkspace.Repository
	// Current is the hub's fresh decision for this exact attempt, as for the
	// registered launch. It is checked before every certificate is asked for.
	Current benchdispatch.SourceGate
}

func (c Coordinator) launch() benchlaunch.Coordinator {
	return benchlaunch.Coordinator{Journal: c.Journal.launch(), Producer: c.Producer, Repositories: c.Repositories, Current: c.Current, Remote: true}
}

func refuse(code string) error { return &benchlaunch.Refusal{Code: code} }

// current is the hub's decision now. A definite stale_owner refuses; a hub
// that cannot say keeps the call pending.
func (c Coordinator) current(ctx context.Context, spec benchdispatch.SourceSpec) error {
	if c.Current == nil || c.Producer == nil || c.Client == nil {
		return refuse("stale_owner")
	}
	err := c.Current(ctx, spec)
	if errors.Is(err, benchlaunch.ErrSuperseded) {
		return refuse("stale_owner")
	}
	if err != nil || ctx.Err() != nil {
		return benchdispatch.ErrPending
	}
	return nil
}

// Prepare creates or recovers the bench, leases it and takes the baseline
// checkpoint, as the registered launch does, with no registration observation
// and no run.
func (c Coordinator) Prepare(ctx context.Context, spec benchdispatch.SourceSpec, task benchdispatch.SourceTask) (benchcoordinator.Prepared, error) {
	return c.launch().Prepare(ctx, spec, task)
}

// Execute is unsupported: a remote launch runs nothing on the bench host.
func (c Coordinator) Execute(context.Context, benchdispatch.SourceSpec, benchdispatch.AdmissionGate) (benchcoordinator.Completion, error) {
	return benchcoordinator.Completion{}, refuse("unsupported")
}

// Status reconciles from the journal, as the registered launch does: a
// prepared record is prepared, a finished one completed. A record the hub has
// definitely superseded is cancelled.
func (c Coordinator) Status(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Status, error) {
	return c.launch().Status(ctx, spec)
}

// Cancel ends this attempt after the hub answered stale_owner: it stops the
// lease (fencing every session), releases it, then retires the record. A
// cancelled record refuses every later attach.
func (c Coordinator) Cancel(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Status, error) {
	return c.launch().Cancel(ctx, spec)
}

// RetireUnlaunched retires this record for a target the node no longer
// serves (the hub said stale_owner): stop, release, retire, as Cancel does. A
// remote record never sends a run, so nothing holds it back.
func (c Coordinator) RetireUnlaunched(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Status, error) {
	return c.launch().RetireUnlaunched(ctx, spec)
}

// Reserved returns the exact spec this journal reserved for the attempt.
func (c Coordinator) Reserved(ctx context.Context, spec benchdispatch.SourceSpec) (benchdispatch.SourceSpec, error) {
	return c.launch().Reserved(ctx, spec)
}

// claim checks the record can take an attach or a finish for binding, under
// the bench lock, and lets change update the remote state.
func (c Coordinator) claim(ctx context.Context, spec benchdispatch.SourceSpec, binding string, change func(*state) (bool, error)) error {
	return c.launch().RemoteUpdate(ctx, spec, func(v benchlaunch.RemoteView) (json.RawMessage, bool, error) {
		s, err := decodeState(v.State)
		switch {
		case err != nil:
			return nil, false, err
		case v.Phase == "completed" || v.Phase == "refused" || v.Cancelled:
			return nil, false, refuse("conflict") // finished or cancelled: nothing is issued for it again
		case !v.Active:
			return nil, false, refuse("stale_owner")
		case v.Binding == nil || v.Phase != "prepared":
			return nil, false, benchdispatch.ErrPending
		case benchdispatch.SourceBindingSHA256(*v.Binding) != binding:
			return nil, false, refuse("conflict")
		}
		save, err := change(&s)
		if err != nil || !save {
			return nil, false, err
		}
		return s.encode(), true, nil
	})
}

// Attach issues a writer certificate for publicKey on the lease this record
// holds. Called again with the same key it renews the certificate (benchd
// extends live connections); a different key is refused. The token goes to
// benchd only; the reply carries the certificate and how to use it.
func (c Coordinator) Attach(ctx context.Context, spec benchdispatch.SourceSpec, binding, publicKey string) (benchworkspace.RemoteCredential, error) {
	var zero benchworkspace.RemoteCredential
	fingerprint, err := Fingerprint(publicKey)
	if err != nil {
		return zero, refuse("invalid")
	}
	if err = c.current(ctx, spec); err != nil {
		return zero, err
	}
	err = c.claim(ctx, spec, binding, func(s *state) (bool, error) {
		switch {
		case s.Finishing:
			return false, refuse("conflict")
		case s.Fingerprint == fingerprint:
			return false, nil
		case s.Fingerprint != "":
			return false, refuse("conflict") // one key per attempt
		}
		s.Fingerprint = fingerprint
		return true, nil
	})
	if err != nil {
		return zero, err
	}
	l := c.launch()
	token, err := l.LeaseToken(ctx, spec)
	if err != nil {
		return zero, err
	}
	credential, err := c.Client.RemoteCredential(ctx, benchworkspace.RemoteCredentialRequest{Key: spec.BenchKey, LeaseToken: token, PublicKey: publicKey})
	if err != nil {
		return zero, credentialRefusal(err)
	}
	id, err := c.Client.RemoteExecutionID(ctx, spec.BenchKey)
	if errors.Is(err, benchworkspace.ErrInvalid) || err == nil && !hex32.MatchString(id) {
		return zero, refuse("verification_failed")
	}
	if err != nil {
		return zero, benchdispatch.ErrPending // listed nothing yet, or unreachable: the same key renews
	}
	err = c.claim(ctx, spec, binding, func(s *state) (bool, error) {
		if s.Finishing || s.Fingerprint != fingerprint {
			return false, refuse("conflict")
		}
		if s.ExecutionID == id {
			return false, nil
		}
		s.ExecutionID = id // a new execution after a benchd restart or a fenced checkpoint
		return true, nil
	})
	if err != nil {
		return zero, err
	}
	if err = c.current(ctx, spec); err != nil {
		return zero, err
	}
	return credential, nil
}

// credentialRefusal maps benchd's answer to a certificate request. Nothing is
// ended: the hub decides, and a renewal may still succeed.
func credentialRefusal(err error) error {
	var f *benchworkspace.Failure
	if !errors.As(err, &f) {
		if errors.Is(err, benchworkspace.ErrInvalid) {
			return refuse("verification_failed")
		}
		return benchdispatch.ErrPending
	}
	if f.Uncertain {
		return benchdispatch.ErrPending
	}
	switch f.Code {
	case "forbidden", "not_found":
		return refuse("stale_owner") // the token no longer owns the lease
	case "conflict":
		return refuse("conflict")
	case "invalid_request":
		return refuse("invalid")
	}
	return benchdispatch.ErrPending
}

// Report is what the agent's turn returns: its handoff and outcome.
type Report struct {
	Handoff map[string]string
	Outcome string
}

// Canonical is the report's canonical bytes (sorted keys, ASCII escapes),
// whose SHA-256 the completion carries as the worker result digest.
func (r Report) Canonical() ([]byte, error) {
	if r.Outcome != "complete" || r.Handoff == nil {
		return nil, benchdispatch.ErrInvalid
	}
	handoff, err := json.Marshal(r.Handoff)
	if err != nil {
		return nil, benchdispatch.ErrInvalid
	}
	if handoff, err = benchcanonical.Canonical(handoff); err != nil || len(handoff) > MaxHandoff {
		return nil, benchdispatch.ErrInvalid
	}
	raw, err := json.Marshal(map[string]any{"handoff": r.Handoff, "outcome": r.Outcome})
	if err != nil {
		return nil, benchdispatch.ErrInvalid
	}
	return benchcanonical.Canonical(raw)
}

var digest = benchattempt.RawSHA256

// Finish journals the agent's report, then checkpoints the bench, stops the
// lease and releases it, and completes. benchd fences every session before
// the checkpoint. A tree with uncommitted or untracked files refuses "dirty":
// the lease stays held, and the same record may attach and finish again.
func (c Coordinator) Finish(ctx context.Context, spec benchdispatch.SourceSpec, binding string, report Report) (benchcoordinator.Completion, error) {
	var zero benchcoordinator.Completion
	reportBytes, err := report.Canonical()
	if err != nil {
		return zero, refuse("invalid")
	}
	if err = c.current(ctx, spec); err != nil {
		return zero, err
	}
	l := c.launch()
	var view benchlaunch.RemoteView
	var s state
	err = c.claim(ctx, spec, binding, func(st *state) (bool, error) {
		switch {
		case st.ExecutionID == "":
			return false, refuse("conflict") // never attached: there is no remote work to finish
		case st.Checkpointed && string(st.Report) != string(reportBytes):
			return false, refuse("conflict") // the work was checkpointed under another report
		}
		changed := !st.Finishing || string(st.Report) != string(reportBytes)
		st.Finishing, st.Report = true, reportBytes
		s = *st
		return changed, nil
	})
	if code, ok := benchlaunch.RefusalCode(err); ok && code == "conflict" {
		// A finish that already completed (its reply was lost) answers its
		// completion again, or the record's own refusal.
		if done, e := c.finished(ctx, spec, binding, reportBytes); e == nil || !errors.Is(e, errNotFinished) {
			return done, e
		}
	}
	if err != nil {
		return zero, err
	}
	_ = l.RemoteUpdate(ctx, spec, func(v benchlaunch.RemoteView) (json.RawMessage, bool, error) {
		view = v
		return nil, false, nil
	})
	if view.Binding == nil {
		return zero, benchdispatch.ErrPending
	}
	b := *view.Binding
	token, err := l.LeaseToken(ctx, spec)
	if err != nil {
		return zero, err
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "checkpoint", Key: spec.BenchKey, LeaseToken: token}
	reply, body, _, err := l.Exchange(ctx, spec, "finish_checkpoint", request)
	if err != nil {
		return zero, err
	}
	if !reply.OK {
		if reply.Error.Code == "conflict" && strings.HasPrefix(reply.Error.Message, dirtyMessage) {
			// The tree is not clean. benchd fenced the sessions before it
			// looked; the lease stays ours, so the agent can attach again,
			// commit, and finish. The refusal is forgotten, never replayed.
			l.Forget(ctx, spec, "finish_checkpoint")
			_ = c.claim(ctx, spec, binding, func(st *state) (bool, error) { st.Finishing = false; return true, nil })
			return zero, &benchlaunch.Refusal{Code: "dirty", Message: benchlaunch.ProducerMessage(reply.Error)}
		}
		code := benchlaunch.RefusalFor(reply.Error.Code)
		return zero, l.Terminate(ctx, spec, code, code != "stale_owner", benchlaunch.ProducerMessage(reply.Error))
	}
	cp, _ := reply.Result.(*benchworkspace.Mutation)
	if !checkpointed(spec, b, cp) {
		return zero, l.Terminate(ctx, spec, "verification_failed", true, "")
	}
	if err = c.claim(ctx, spec, binding, func(st *state) (bool, error) {
		changed := !st.Checkpointed
		st.Checkpointed = true
		return changed, nil
	}); err != nil {
		return zero, err
	}
	if err = l.Release(ctx, spec); err != nil {
		return zero, err // stop and release are retried by the next finish or status
	}
	receipt, err := benchcanonical.ReceiptDigest(body)
	if err != nil {
		return zero, l.Terminate(ctx, spec, "verification_failed", false, "")
	}
	w := cp.Workspace
	checkpoints := make([]benchattempt.Source, 0, len(b.Sources))
	for i, m := range w.Checkpoint.Members {
		src := b.Sources[i]
		src.Commit = m.Commit
		checkpoints = append(checkpoints, src)
	}
	service := benchdispatch.Observation{RequestID: spec.RunRequestID, RequestSHA256: b.RequestSHA256, BodySHA256: b.BodySHA256, ResponseSHA256: digest(body),
		WorkerResultSHA256: digest(reportBytes), ExecutionID: s.ExecutionID, Stopped: true, Released: true, Checkpoints: checkpoints, Kind: "grouped-v2",
		GenerationID: w.Checkpoint.GenerationID, SealCommit: w.Checkpoint.Seal, ManifestSHA256: w.Checkpoint.ManifestSHA256}
	task := superbench.WorkerResult{Version: superbench.GroupedWorkerVersion, Binding: superbench.Binding{BoardID: spec.Identity.BoardID, CardID: spec.Identity.CardID, RunID: spec.Identity.RunID, Epoch: spec.Identity.Epoch},
		Outcome: report.Outcome, Handoff: report.Handoff}
	completion := benchcoordinator.Completion{Source: b, Service: service, Task: task, SourceRequestSHA256: view.SourceRequestSHA256, SourceReceiptSHA256: receipt}
	if err = l.Complete(ctx, spec, completion); err != nil {
		return zero, err
	}
	return completion, nil
}

var errNotFinished = errors.New("remote record not finished")

// finished answers a finish for a record that already ended: its completion
// for the same binding and report, or its own refusal.
func (c Coordinator) finished(ctx context.Context, spec benchdispatch.SourceSpec, binding string, report []byte) (benchcoordinator.Completion, error) {
	var zero benchcoordinator.Completion
	var view benchlaunch.RemoteView
	if err := c.launch().RemoteUpdate(ctx, spec, func(v benchlaunch.RemoteView) (json.RawMessage, bool, error) {
		view = v
		return nil, false, nil
	}); err != nil {
		return zero, err
	}
	s, err := decodeState(view.State)
	if err != nil || view.Binding == nil || benchdispatch.SourceBindingSHA256(*view.Binding) != binding {
		return zero, errNotFinished
	}
	switch view.Phase {
	case "completed":
		if string(s.Report) != string(report) {
			return zero, refuse("conflict")
		}
	case "refused":
	default:
		return zero, errNotFinished
	}
	status, err := c.Status(ctx, spec)
	if err != nil {
		return zero, err
	}
	if status.State != "completed" || status.Completion == nil {
		return zero, benchdispatch.ErrPending
	}
	return *status.Completion, nil
}

// checkpointed reports a finishing checkpoint of this record's bench, still
// held by its holder, with a checkpoint for every bound repository.
func checkpointed(spec benchdispatch.SourceSpec, b benchdispatch.SourceBinding, m *benchworkspace.Mutation) bool {
	if m == nil {
		return false
	}
	w := m.Workspace
	if w.Key != spec.BenchKey || w.BenchID != b.BenchID || w.Lease == nil || w.Lease.Holder != spec.Holder || w.Checkpoint == nil || len(w.Checkpoint.Members) != len(b.Sources) ||
		!hex32.MatchString(w.Checkpoint.GenerationID) {
		return false
	}
	for i, member := range w.Checkpoint.Members {
		if member.Name != b.Sources[i].Name || len(member.Commit) != len(b.Sources[i].Commit) {
			return false
		}
	}
	return true
}
