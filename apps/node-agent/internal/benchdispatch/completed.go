package benchdispatch

import (
	"context"
	"path/filepath"
	"reflect"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcanonical"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// Completed reparses preserved historical evidence; it never grants or launches.
// Disclosure/current admission remain the authenticated adapter's responsibility.
func (s Store) Completed(ctx context.Context, spec SourceSpec) (b SourceBinding, o Observation, task superbench.WorkerResult, err error) {
	return s.completed(ctx, spec, nil)
}

func (s Store) completed(ctx context.Context, spec SourceSpec, canonical *benchcanonical.Digests) (b SourceBinding, o Observation, task superbench.WorkerResult, err error) {
	var p Plan
	if !validSourceSpec(spec) {
		return SourceBinding{}, o, task, ErrInvalid
	}
	p, b, err = s.sourceBinding(ctx, spec)
	if err != nil {
		return SourceBinding{}, o, task, err
	}
	err = s.withState(ctx, p, false, func(doc *state) (bool, error) {
		r, e := find(doc, p)
		if e != nil {
			return false, e
		}
		if r.Phase != "proposed" {
			return false, ErrPending
		}
		if r.Source == nil || sourceDigest(r.Source.Spec) != sourceDigest(spec) || s.boundSourceEvidence(r) != nil {
			return false, ErrVerify
		}
		o, e = s.runObservation(spec, p)
		if e != nil {
			return false, e
		}
		var saved Proposal
		if decode(r.Proposal, &saved) != nil {
			return false, ErrVerify
		}
		if !reflect.DeepEqual(o, saved.Observation) {
			return false, ErrVerify
		}
		raw, e := readFile(filepath.Join(p.ContextPath, "result.json"), superbench.MaxWorker, true)
		if e != nil || digest(raw) != o.WorkerResultSHA256 || decode(raw, &task) != nil {
			return false, ErrVerify
		}
		if canonical != nil {
			*canonical, e = s.canonicalRun(spec, p, &o)
			if e != nil {
				return false, e
			}
		}
		return false, nil
	})
	if err != nil {
		return SourceBinding{}, Observation{}, superbench.WorkerResult{}, err
	}
	return b, o, task, nil
}
