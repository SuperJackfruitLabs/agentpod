package benchdispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strconv"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// SourceBinding is a credential-free observation of exact preserved producer
// replies. It is not an admission, signature, or proof of an isolated writer.
type SourceBinding struct {
	Identity      Identity                   `json:"identity"`
	HostID        string                     `json:"host_id"`
	BenchKey      string                     `json:"bench_key"`
	BenchID       string                     `json:"bench_id"`
	Sources       []Source                   `json:"sources"`
	Members       []superbench.GroupedMember `json:"members"`
	Checkpoint    benchworkspace.Checkpoint  `json:"checkpoint"`
	Operations    []SourceOperation          `json:"operations"`
	RequestSHA256 string                     `json:"request_sha256"`
	BodySHA256    string                     `json:"body_sha256"`
	ContextSHA256 string                     `json:"context_sha256"`
	WorkerSHA256  string                     `json:"worker_sha256"`
}

// SourceBindingSHA256 identifies exact projection bytes; it grants no authority.
func SourceBindingSHA256(b SourceBinding) string { raw, _ := json.Marshal(b); return digest(raw) }

// AdmissionGate must independently authenticate the Hub's current admitted
// source and control pair against this exact binding. No production route
// supplies it yet. Neither a matching hash nor this callback type is authority.
type AdmissionGate func(context.Context, SourceBinding) error

func (s Store) sourceBinding(ctx context.Context, spec SourceSpec) (Plan, SourceBinding, error) {
	var p Plan
	var b SourceBinding
	err := s.withDocument(ctx, spec.BenchKey, false, func(doc *state) (bool, error) {
		for i := range doc.Records {
			r := &doc.Records[i]
			if r.Source == nil || sourceDigest(r.Source.Spec) != sourceDigest(spec) {
				continue
			}
			if r.Phase == "superseded" {
				return false, ErrOwner
			}
			if e := s.boundSourceEvidence(r); e != nil {
				return false, e
			}
			p = r.Plan
			var cp *benchworkspace.Mutation
			for _, op := range r.Source.Operations {
				if op.Step == "checkpoint" {
					reply, e := s.observedSourceReply(spec, op)
					if e != nil {
						return false, e
					}
					cp = sourceMutation(reply)
				}
			}
			if cp == nil || cp.Workspace.Checkpoint == nil {
				return false, ErrVerify
			}
			b = SourceBinding{Identity: p.Identity, HostID: p.HostID, BenchKey: p.BenchKey, BenchID: p.RegistrationID, Sources: append([]Source(nil), p.Sources...), Members: append([]superbench.GroupedMember(nil), p.Grouped.Members...), Checkpoint: *cp.Workspace.Checkpoint, Operations: append([]SourceOperation(nil), r.Source.Operations...), RequestSHA256: p.RequestSHA256, BodySHA256: p.BodySHA256, ContextSHA256: p.ContextSHA256, WorkerSHA256: p.ExecutableSHA256}
			return false, nil
		}
		return false, ErrOwner
	})
	return p, b, err
}

// Binding exposes only the immutable observed start identity, never a path or
// continuation. The caller must still authenticate and store source admission.
func (c SourceCoordinator) Binding(ctx context.Context, spec SourceSpec) (SourceBinding, error) {
	if !validSourceSpec(spec) || c.Current == nil || c.Current(ctx, spec) != nil {
		return SourceBinding{}, ErrOwner
	}
	_, b, e := c.Store.sourceBinding(ctx, spec)
	return b, e
}

func (s Store) boundRun(p Plan, spec SourceSpec) (benchworkspace.Request, []byte, error) {
	raw, e := readFile(filepath.Join(s.Root, sourceFile(spec, "run", ".request")), benchworkspace.MaxBody+len(privateSourceRequestHeader), true)
	if e != nil || !bytes.HasPrefix(raw, []byte(privateSourceRequestHeader)) {
		return benchworkspace.Request{}, nil, ErrInvalid
	}
	raw = raw[len(privateSourceRequestHeader):]
	r, e := benchworkspace.Parse(raw)
	if e != nil || validateLaunch(p, raw) != nil {
		return r, nil, ErrInvalid
	}
	return r, raw, nil
}

func (s Store) captureRun(spec SourceSpec, p Plan, evidence *benchworkspace.ExchangeEvidence) error {
	return evidence.Use(func(status int, request, response []byte) error {
		if digest(request) != p.RequestSHA256 || len(response) == 0 || status < 100 || status > 599 {
			return ErrVerify
		}
		sent, raw, e := s.boundRun(p, spec)
		if e != nil || !bytes.Equal(raw, request) {
			return ErrVerify
		}
		if _, e = benchworkspace.ParseResponse(response, status, sent); e != nil {
			return ErrVerify
		}
		return s.writeSourceFile(sourceFile(spec, "run", ".response"), append([]byte(strconv.Itoa(status)+"\n"), response...))
	})
}

func (s Store) runObservation(spec SourceSpec, p Plan) (Observation, error) {
	var o Observation
	sent, _, e := s.boundRun(p, spec)
	if e != nil {
		return o, e
	}
	raw, e := readFile(filepath.Join(s.Root, sourceFile(spec, "run", ".response")), benchworkspace.MaxResponse+4, true)
	if e != nil || len(raw) < 4 || raw[3] != '\n' {
		return o, ErrPending
	}
	status, e := strconv.Atoi(string(raw[:3]))
	if e != nil {
		return o, ErrVerify
	}
	reply, e := benchworkspace.ParseResponse(raw[4:], status, sent)
	if e != nil || !reply.OK {
		return o, ErrPending
	}
	run, ok := reply.Result.(*benchworkspace.RunOutcome)
	if !ok {
		return o, ErrVerify
	}
	w := run.Workspace
	if w.BenchID != p.RegistrationID || w.Key != p.BenchKey || w.MemberCount != len(p.Sources) || w.CheckpointRepository != spec.CheckpointRepository || w.Phase != "ready" || w.TransferState != "" || w.Archive != nil || w.Lease != nil || w.Pending != nil || !w.ReadyForAcquisition || w.Checkpoint == nil || len(w.Checkpoint.Members) != len(p.Sources) || run.Execution == nil || run.Execution.Phase != "stopped" || run.ExitCode == nil || *run.ExitCode != 0 {
		return o, ErrVerify
	}
	binding := superbench.Binding{BoardID: p.Identity.BoardID, CardID: p.Identity.CardID, RunID: p.Identity.RunID, Epoch: p.Identity.Epoch}
	if _, e = superbench.ReadGroupedWorkerResult(p.ContextPath, binding); e != nil {
		return o, ErrVerify
	}
	result, e := readFile(filepath.Join(p.ContextPath, "result.json"), superbench.MaxWorker, true)
	if e != nil {
		return o, ErrVerify
	}
	// Revalidate the exact bytes hashed below rather than a second path read.
	var decoded superbench.WorkerResult
	if decode(result, &decoded) != nil || decoded.Version != superbench.GroupedWorkerVersion || decoded.Binding != binding || decoded.Handoff == nil || decoded.Outcome != "complete" && decoded.Outcome != "blocked" && decoded.Outcome != "failed" {
		return o, ErrVerify
	}
	o = Observation{RequestID: p.RequestID, RequestSHA256: p.RequestSHA256, BodySHA256: p.BodySHA256, ResponseSHA256: digest(raw[4:]), WorkerResultSHA256: digest(result), ExecutionID: run.Execution.ID, Stopped: true, Released: true, Kind: "grouped-v2", GenerationID: w.Checkpoint.GenerationID, SealCommit: w.Checkpoint.Seal, ManifestSHA256: w.Checkpoint.ManifestSHA256}
	for i, c := range w.Checkpoint.Members {
		src := p.Sources[i]
		if c.Name != src.Name || p.Grouped.Members[i].ObjectFormat == "sha1" && len(c.Commit) != 40 || p.Grouped.Members[i].ObjectFormat == "sha256" && len(c.Commit) != 64 {
			return Observation{}, ErrVerify
		}
		src.Commit = c.Commit
		o.Checkpoints = append(o.Checkpoints, src)
	}
	return o, validateObservation(p, o)
}

// ExecuteBound consumes the original launch once and invokes the concrete Unix
// client. Lost replies remain parked; retries may only reconcile captured bytes.
// The returned proposal is observed evidence, not board settlement acceptance.
func (c SourceCoordinator) ExecuteBound(ctx context.Context, spec SourceSpec, admit AdmissionGate) ([]byte, error) {
	if !validSourceSpec(spec) || c.Client == nil || c.Current == nil || admit == nil {
		return nil, ErrInvalid
	}
	p, b, e := c.Store.sourceBinding(ctx, spec)
	if e != nil {
		return nil, e
	}
	gate := func(ctx context.Context, _ Plan) error {
		if c.Current(ctx, spec) != nil || admit(ctx, b) != nil || c.Current(ctx, spec) != nil || ctx.Err() != nil {
			return ErrOwner
		}
		return nil
	}
	if gate(ctx, p) != nil {
		return nil, ErrOwner
	}
	var historical []byte
	e = c.Store.withState(ctx, p, false, func(doc *state) (bool, error) {
		r, e := find(doc, p)
		if e != nil {
			return false, e
		}
		if r.Phase == "proposed" {
			historical = append([]byte(nil), r.Proposal...)
		}
		return false, nil
	})
	if e != nil {
		return nil, e
	}
	if historical != nil {
		return historical, nil
	}
	request, raw, e := c.Store.boundRun(p, spec)
	if e != nil {
		return nil, e
	}
	e = c.Store.Dispatch(ctx, p, raw, gate, func(ctx context.Context) error {
		_, evidence, _ := c.Client.DoWithEvidence(ctx, request)
		save, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return c.Store.withState(save, p, false, func(doc *state) (bool, error) {
			if _, e := find(doc, p); e != nil {
				return false, e
			}
			return false, c.Store.captureRun(spec, p, evidence)
		})
	})
	if e != nil && !errors.Is(e, ErrPending) {
		return nil, e
	}
	o, e := c.Store.runObservation(spec, p)
	if e != nil {
		return nil, e
	}
	return c.Store.StageProposal(ctx, p, o, gate, func(_ context.Context, _ Plan, want Observation) error {
		actual, e := c.Store.runObservation(spec, p)
		a, _ := json.Marshal(actual)
		z, _ := json.Marshal(want)
		if e != nil || !bytes.Equal(a, z) {
			return ErrVerify
		}
		return nil
	})
}
