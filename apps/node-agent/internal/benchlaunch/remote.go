package benchlaunch

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// The remote launch (package benchremote) reuses this launch's journaled
// steps: create or recover, lease, baseline checkpoint, release, and the
// supersede and retire paths. It binds no run; the agent works in the bench
// over SSH with a certificate benchremote asks benchd for. Only what that
// reuse needs is exported here.

// RemoteRequestVersion names the remote launch's bound request: the exact
// bytes the binding's request, body and context digests identify in place of
// a run request.
const RemoteRequestVersion = "agentpod.remote-launch-request.v1"

// bindRemote binds the leased, checkpointed bench for a remote launch. The
// bound request names the bench generation, holder and baseline checkpoint;
// nothing in it reaches a payload.
func (c Coordinator) bindRemote(ctx context.Context, spec benchdispatch.SourceSpec, lease, cp *benchworkspace.Mutation, operations []benchattempt.SourceOperation) (benchcoordinator.Prepared, error) {
	var zero benchcoordinator.Prepared
	members := make([]superbench.GroupedMember, 0, len(spec.Repositories))
	sources := make([]benchattempt.Source, 0, len(spec.Repositories))
	for i, repo := range spec.Repositories {
		commit := cp.Workspace.Checkpoint.Members[i].Commit
		if cp.Workspace.Checkpoint.Members[i].Name != repo.Name || repo.ObjectFormat == "sha1" && len(commit) != 40 || repo.ObjectFormat == "sha256" && len(commit) != 64 {
			return zero, c.terminate(ctx, spec, "verification_failed", true)
		}
		members = append(members, superbench.GroupedMember{Name: repo.Name, RepositorySHA256: repo.RepositorySHA256, TaskRef: repo.TaskRef, ObjectFormat: repo.ObjectFormat, Commit: commit})
		sources = append(sources, benchattempt.Source{Name: repo.Name, RepositorySHA256: repo.RepositorySHA256, TaskRef: repo.TaskRef, Commit: commit})
	}
	// A map marshals with sorted keys and these values are ASCII, so the bytes
	// are already canonical: one digest names the request, its body and the
	// source request.
	raw, err := json.Marshal(map[string]string{"version": RemoteRequestVersion, "key": spec.BenchKey, "bench_id": lease.Workspace.BenchID, "holder": spec.Holder,
		"request_id": spec.RunRequestID, "generation_id": cp.Workspace.Checkpoint.GenerationID, "seal": cp.Workspace.Checkpoint.Seal})
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", true)
	}
	sha := digest(raw)
	b := benchdispatch.SourceBinding{Identity: spec.Identity, HostID: spec.HostID, BenchKey: spec.BenchKey, BenchID: lease.Workspace.BenchID, Sources: sources, Members: members,
		Checkpoint: *cp.Workspace.Checkpoint, Operations: operations, RequestSHA256: sha, BodySHA256: sha, ContextSHA256: sha, WorkerSHA256: spec.WorkerSHA256}
	var out record
	err = c.Journal.withRecord(ctx, spec, func(r *record, active bool) (bool, error) {
		if r.Binding != nil {
			out = *r
			return false, nil
		}
		if !active || r.Cancelled || r.Phase != phaseReserved || c.current(ctx, spec) != nil {
			return false, refuse("stale_owner")
		}
		r.Binding, r.SourceSHA, r.Phase = &b, sha, phasePrepared
		out = *r
		return true, nil
	})
	if err != nil {
		return zero, err
	}
	return prepared(out)
}

// stopRemote stops the lease with its own token before a remote launch
// releases it, which fences any session still open on it. A refused stop (the
// lease has nothing running, say) does not hold the release back; a lost one
// stays pending and is sent again.
func (c Coordinator) stopRemote(ctx context.Context, spec benchdispatch.SourceSpec, token string) error {
	if !c.Remote {
		return nil
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "stop", Key: spec.BenchKey, LeaseToken: token}
	_, err := c.ordinary(ctx, spec, "remote_stop", request, true)
	var refusal *Refusal
	if err != nil && !errors.As(err, &refusal) {
		return err
	}
	return nil
}

// DirtyMessage is how SuperBench begins its refusal to checkpoint (or release)
// a tree with uncommitted or untracked files.
const DirtyMessage = "workspace has uncommitted or untracked files"

// saveRemote runs before a refused (retired or failed) remote record releases
// its lease (operator ruling, 2026-11-26). A clean tree is checkpointed with
// the record's own token, so the agent's commits are kept and the release that
// follows can succeed; the record stays refused, so nothing is reported as a
// pass. A dirty tree is never discarded: benchd fenced its sessions, the lease
// stays held, and the refusal is journaled as a held release (lease "held", with
// SuperBench's message) for an operator. held reports that case. The refusal is
// forgotten, so a later status checkpoints again once the tree is clean, and a
// lease an operator already released is found gone by the release below.
func (c Coordinator) saveRemote(ctx context.Context, spec benchdispatch.SourceSpec, r record, token string) (held bool, err error) {
	if !c.Remote || r.Phase != phaseRefused {
		return false, nil
	}
	// A stopped lease can never checkpoint: benchd refuses the payload's Git and leaves the checkpoint
	// pending, which renew_admin then refuses. So the lease is read first, and a lease that is stopped
	// (by this record's own earlier stop, or an operator's stop_admin on a held bench), not ours, or
	// already pending goes straight to its release. A status that cannot be read is asked again.
	w := c.bench(ctx, spec)
	if w == nil {
		return false, benchdispatch.ErrPending
	}
	if w.Lease == nil || w.Lease.Holder != spec.Holder || w.Lease.StopRequested || w.Pending != nil {
		return false, nil
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "checkpoint", Key: spec.BenchKey, LeaseToken: token}
	reply, err := c.ordinary(ctx, spec, "retire_checkpoint", request, true)
	if err != nil {
		var refusal *Refusal
		if errors.As(err, &refusal) {
			return false, nil // a reply that does not parse: the release decides
		}
		return false, err // lost: sent again
	}
	if reply.OK || reply.Error == nil || reply.Error.Code != "conflict" || !strings.HasPrefix(reply.Error.Message, DirtyMessage) {
		return false, nil // saved, or refused for another reason (a lease already gone, say): the release decides
	}
	// benchd fenced every session before it looked; the lease is not stopped, so the checkpoint can
	// be taken with this token once the tree is clean.
	c.forget(ctx, spec, "retire_checkpoint")
	message := producerMessage(reply.Error)
	_ = c.mark(ctx, spec, func(r *record) bool { r.ReleaseRefusal = message; return true })
	c.releaseFailed(ctx, spec)
	return true, benchdispatch.ErrPending
}

// RemoteView is what a remote launch reads of its own record.
type RemoteView struct {
	// Phase is reserved, prepared, completed or refused.
	Phase     string
	Active    bool
	Cancelled bool
	Binding   *benchdispatch.SourceBinding
	// SourceRequestSHA256 is the bound request's canonical digest.
	SourceRequestSHA256 string
	// State is the remote launch's own journaled state, or nil.
	State json.RawMessage
}

// RemoteUpdate runs fn on the spec's record under the bench lock. fn returns
// the remote launch's new state and whether to save it.
func (c Coordinator) RemoteUpdate(ctx context.Context, spec benchdispatch.SourceSpec, fn func(RemoteView) (json.RawMessage, bool, error)) error {
	return c.Journal.withRecord(ctx, spec, func(r *record, active bool) (bool, error) {
		view := RemoteView{Phase: r.Phase, Active: active, Cancelled: r.Cancelled, Binding: r.Binding, SourceRequestSHA256: r.SourceSHA, State: append(json.RawMessage(nil), r.Remote...)}
		state, save, err := fn(view)
		if err != nil || !save {
			return false, err
		}
		r.Remote = append(json.RawMessage(nil), state...)
		return true, nil
	})
}

// LeaseToken is the token of the lease grant this record journaled. It reads
// the journal only; nothing is sent.
func (c Coordinator) LeaseToken(ctx context.Context, spec benchdispatch.SourceSpec) (string, error) {
	r, _, err := c.Journal.read(ctx, spec)
	if err != nil {
		return "", benchdispatch.ErrPending
	}
	s := r.step("lease")
	if s == nil || s.Response == nil {
		return "", benchdispatch.ErrPending
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "lease", Key: spec.BenchKey, Holder: spec.Holder, RequestID: spec.LeaseRequestID}
	reply, err := benchworkspace.ParseResponse(s.Response, s.Status, request)
	m := mutationOf(reply)
	if err != nil || !reply.OK || m == nil || m.Grant == nil {
		return "", refuse("stale_owner")
	}
	return m.Grant.LeaseToken, nil
}

// Exchange performs one journaled, non-growth step under its own name: the
// reply is kept and replayed until Forget drops it. It returns the parsed
// reply, the exact reply bytes and their HTTP status.
func (c Coordinator) Exchange(ctx context.Context, spec benchdispatch.SourceSpec, name string, request benchworkspace.Request) (benchworkspace.Response, []byte, int, error) {
	if benchworkspace.Growth(request.Operation) || name == "lease" || name == "create" || name == "checkpoint" || name == "release" || name == "remote_stop" {
		return benchworkspace.Response{}, nil, 0, benchdispatch.ErrInvalid
	}
	reply, err := c.ordinary(ctx, spec, name, request, false)
	if err != nil {
		return benchworkspace.Response{}, nil, 0, err
	}
	r, _, err := c.Journal.read(ctx, spec)
	s := r.step(name)
	if err != nil || s == nil || s.Response == nil {
		return benchworkspace.Response{}, nil, 0, benchdispatch.ErrPending
	}
	return reply, append([]byte(nil), s.Response...), s.Status, nil
}

// Forget drops a step Exchange journaled, so the next Exchange sends it again.
func (c Coordinator) Forget(ctx context.Context, spec benchdispatch.SourceSpec, name string) {
	c.forget(ctx, spec, name)
}

// Release stops and releases the lease this record holds, with its own token.
// It returns nil once the lease is gone, ErrPending while it is not.
func (c Coordinator) Release(ctx context.Context, spec benchdispatch.SourceSpec) error {
	if err := c.cleanup(ctx, spec); err != nil {
		return err
	}
	r, _, err := c.Journal.read(ctx, spec)
	if err != nil || r.Release == "needed" {
		return benchdispatch.ErrPending
	}
	return nil
}

// Complete ends the record with its completion. Release must have succeeded.
func (c Coordinator) Complete(ctx context.Context, spec benchdispatch.SourceSpec, completion benchcoordinator.Completion) error {
	err := c.mark(ctx, spec, func(r *record) bool {
		if r.Phase != phasePrepared || r.Cancelled || r.Release == "needed" {
			return false
		}
		r.Phase, r.Completion, r.Release = phaseCompleted, &completion, "done"
		return true
	})
	if err != nil {
		return benchdispatch.ErrPending
	}
	if done, _, e := c.Journal.read(ctx, spec); e != nil {
		return benchdispatch.ErrPending
	} else if done.Phase != phaseCompleted || done.Completion == nil {
		return refuse("stale_owner") // cancelled while it was finishing
	}
	return nil
}

// Terminate ends the record refused with code and SuperBench's message, and
// releases the lease when held says the record still owns it.
func (c Coordinator) Terminate(ctx context.Context, spec benchdispatch.SourceSpec, code string, held bool, message string) error {
	return c.terminateWith(ctx, spec, code, held, message, "")
}

// RefusalFor maps a definite SuperBench refusal code to the coordinator wire code.
func RefusalFor(code string) string { return refusalFor(code) }

// ProducerMessage is SuperBench's refusal text made safe to carry (see producerMessage).
func ProducerMessage(e *benchworkspace.APIError) string { return producerMessage(e) }
