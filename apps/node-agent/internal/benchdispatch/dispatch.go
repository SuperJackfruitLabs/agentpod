package benchdispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"time"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// Gate must verify the current run/epoch/policy, registered bench/source vector,
// common control principal+grant, and same authoritative host. No callback here
// mints those authorities. In particular station readiness alone is not a gate.
type Gate func(context.Context, Plan) error

// Verify must independently inspect exact trusted service receipt/result bytes,
// bind the worker result to this context, and prove writers stopped, every
// checkpoint published and lease released. It must not trust Observation flags.
// Grouped-v2 remains unaccepted until its producer and consumers are reviewed.
type Verify func(context.Context, Plan, Observation) error

func validateLaunch(p Plan, raw []byte) error {
	if digest(raw) != p.RequestSHA256 {
		return ErrInvalid
	}
	if p.Grouped != nil {
		return validateGroupedLaunch(p, raw)
	}
	r, err := superbench.Parse(raw)
	if err != nil {
		return ErrInvalid
	}
	body, err := r.Digest()
	if err != nil || body != p.BodySHA256 || r.Operation != "run" || r.Key != p.BenchKey || r.Holder != p.Holder || r.RequestID != p.RequestID || len(r.Arguments) != 2 || r.Arguments[0] != p.ExecutablePath || r.Arguments[1] != p.ContextPath || (r.Checkpoint != nil && !*r.Checkpoint) {
		return ErrInvalid
	}
	if physicalDir(p.ContextPath, true) != nil {
		return ErrInvalid
	}
	contextRaw, err := readFile(filepath.Join(p.ContextPath, "request.json"), superbench.MaxWorker, true)
	if err != nil || digest(contextRaw) != p.ContextSHA256 {
		return ErrInvalid
	}
	var spec superbench.WorkerSpec
	d := json.NewDecoder(bytes.NewReader(contextRaw))
	if !utf8.Valid(contextRaw) || unique(d, 0, true) != nil {
		return ErrInvalid
	}
	if _, err = d.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalid
	}
	d = json.NewDecoder(bytes.NewReader(contextRaw))
	d.DisallowUnknownFields()
	if d.Decode(&spec) != nil || spec.Version != superbench.WorkerVersion || spec.Binding.BoardID != p.Identity.BoardID || spec.Binding.CardID != p.Identity.CardID || spec.Binding.RunID != p.Identity.RunID || spec.Binding.Epoch != p.Identity.Epoch {
		return ErrInvalid
	}
	// Packaging is explicit, not an assumption about an installed helper alias.
	// This recheck prevents accidental mutable-path substitution; trusted same-UID
	// commands can still mutate files and are outside the isolation guarantee.
	real, err := filepath.EvalSymlinks(p.ExecutablePath)
	if err != nil || real != p.ExecutablePath {
		return ErrInvalid
	}
	binary, err := readFile(p.ExecutablePath, 64<<20, false)
	if err != nil || digest(binary) != p.ExecutableSHA256 {
		return ErrInvalid
	}
	return nil
}

// Dispatch durably consumes the one launch opportunity BEFORE invoking launch.
// A timeout, lost reply, callback error, or crash leaves pending/uncertain state;
// neither this method nor inspection/status/reconciliation ever redispatches it.
// launch must call benchd.run itself, never launch a parallel unfenced child.
func (s Store) Dispatch(ctx context.Context, p Plan, raw []byte, gate Gate, launch func(context.Context) error) error {
	if gate == nil || launch == nil || validatePlan(p) != nil {
		return ErrInvalid
	}
	err := s.withState(ctx, p, false, func(doc *state) (bool, error) {
		r, e := find(doc, p)
		if e != nil {
			return false, e
		}
		if doc.Active != planID(p) || r.Phase == "superseded" {
			return false, ErrOwner
		}
		if r.Phase != "prepared" {
			return false, ErrPending
		}
		if validateLaunch(p, raw) != nil {
			return false, ErrInvalid
		}
		if gate(ctx, p) != nil || ctx.Err() != nil {
			return false, ErrOwner
		}
		r.Phase = "pending"
		return true, nil
	})
	if err != nil {
		return err
	}
	// Supersede can arrive while this call is awaiting the service. It parks the
	// attempt and cannot cancel a later holder or rewrite the returned evidence.
	if launch(ctx) != nil {
		// Use an independent context only to preserve uncertainty, never to retry
		// execution. A failed write leaves the already durable pending intent.
		repairCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.withState(repairCtx, p, false, func(doc *state) (bool, error) {
			r, e := find(doc, p)
			if e != nil {
				return false, e
			}
			if r.Phase != "pending" {
				return false, nil
			}
			r.Phase = "uncertain"
			return true, nil
		})
		return ErrPending
	}
	return nil
}

// StageProposal records immutable cap-free observed evidence for future hub
// settlement. It neither submits a board mutation nor certifies shared policy.
// Exact same-attempt replay returns identical bytes without rerunning anything.
func (s Store) StageProposal(ctx context.Context, p Plan, o Observation, gate Gate, verify Verify) ([]byte, error) {
	if gate == nil || verify == nil || validateObservation(p, o) != nil {
		return nil, ErrVerify
	}
	var replay []byte
	err := s.withState(ctx, p, false, func(doc *state) (bool, error) {
		r, e := find(doc, p)
		if e != nil {
			return false, e
		}
		if r.Phase == "proposed" {
			proposal := Proposal{Version: version, PlanSHA256: planDigest(p), Plan: p, Observation: o}
			raw, _ := json.Marshal(proposal)
			if digest(raw) != r.ProposalSHA256 {
				return false, ErrConflict
			}
			replay = append([]byte(nil), r.Proposal...)
			return false, nil
		}
		if doc.Active != planID(p) || (r.Phase != "pending" && r.Phase != "uncertain") {
			return false, ErrOwner
		}
		for _, prior := range doc.Records {
			if prior.Phase != "proposed" {
				continue
			}
			var old Proposal
			if decode(prior.Proposal, &old) != nil {
				return false, ErrInvalid
			}
			if old.Observation.ExecutionID == o.ExecutionID {
				return false, ErrConflict
			}
		}
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	if replay != nil {
		return replay, nil
	}
	if gate(ctx, p) != nil || verify(ctx, p, o) != nil || ctx.Err() != nil {
		return nil, ErrVerify
	}
	proposal := Proposal{Version: version, PlanSHA256: planDigest(p), Plan: p, Observation: o}
	raw, err := json.Marshal(proposal)
	if err != nil {
		return nil, ErrInvalid
	}
	err = s.withState(ctx, p, false, func(doc *state) (bool, error) {
		r, e := find(doc, p)
		if e != nil {
			return false, e
		}
		if r.Phase == "proposed" {
			if digest(raw) != r.ProposalSHA256 {
				return false, ErrConflict
			}
			return false, nil
		}
		if doc.Active != planID(p) || (r.Phase != "pending" && r.Phase != "uncertain") {
			return false, ErrOwner
		}
		for _, prior := range doc.Records {
			if prior.Phase != "proposed" {
				continue
			}
			var old Proposal
			if decode(prior.Proposal, &old) != nil {
				return false, ErrInvalid
			}
			if old.Observation.ExecutionID == o.ExecutionID {
				return false, ErrConflict
			}
		}
		// Recheck after all asynchronous verification. A replaced policy/epoch is
		// not authorized merely because its earlier check once succeeded.
		if gate(ctx, p) != nil || ctx.Err() != nil {
			return false, ErrOwner
		}
		r.Phase = "proposed"
		r.Proposal = append([]byte(nil), raw...)
		r.ProposalSHA256 = digest(raw)
		doc.Active = ""
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), raw...), nil
}
