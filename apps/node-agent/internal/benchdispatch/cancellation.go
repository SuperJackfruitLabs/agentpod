package benchdispatch

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcleanup"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

const cancellationVersion = "agentpod.private-bench-dispatch.v4"
const legacyCancellationVersion = "agentpod.private-bench-dispatch.v3"

func cancelled(doc *state, id string) bool {
	for _, c := range doc.Cancellations {
		if c.IdentitySHA256 == id {
			return true
		}
	}
	return false
}

// BeginCancellation durably vetoes this exact attempt before cleanup effects.
// A pre-source tombstone also rejects a delayed Prepare after a lost RPC reply.
func (s Store) BeginCancellation(ctx context.Context, spec SourceSpec, gate SourceGate) error {
	if !validSourceSpec(spec) || gate == nil {
		return ErrInvalid
	}
	return s.withDocument(ctx, spec.BenchKey, true, func(doc *state) (bool, error) {
		if gate(ctx, spec) != nil || ctx.Err() != nil {
			return false, ErrOwner
		}
		if _, e := benchattempt.FindCancellation(doc.Cancellations, sourceID(spec), sourceDigest(spec)); e == nil {
			return false, nil
		} else if !errors.Is(e, ErrOwner) {
			return false, e
		}
		if doc.Source != nil && sourceID(doc.Source.Spec) == sourceID(spec) && sourceDigest(doc.Source.Spec) != sourceDigest(spec) {
			return false, ErrConflict
		}
		for _, r := range doc.Records {
			if planID(r.Plan) == sourceID(spec) && (r.Source == nil || sourceDigest(r.Source.Spec) != sourceDigest(spec)) {
				return false, ErrConflict
			}
		}
		if len(doc.Cancellations) >= maxRecords {
			return false, ErrInvalid
		}
		doc.Version = cancellationVersion
		doc.Cancellations = append(doc.Cancellations, benchattempt.Cancellation{IdentitySHA256: sourceID(spec), SourceSHA256: sourceDigest(spec)})
		return true, nil
	})
}
func (s Store) cleanupPlan(doc *state, spec SourceSpec) (*benchcleanup.Plan, error) {
	if _, e := benchattempt.FindCancellation(doc.Cancellations, sourceID(spec), sourceDigest(spec)); e != nil {
		return nil, e
	}
	var source *SourceReservation
	var bound *Record
	if doc.Source != nil && sourceDigest(doc.Source.Spec) == sourceDigest(spec) {
		source = doc.Source
	}
	for i := range doc.Records {
		r := &doc.Records[i]
		if r.Source != nil && sourceDigest(r.Source.Spec) == sourceDigest(spec) {
			source = r.Source
			bound = r
		}
	}
	if source == nil || bound != nil && bound.Phase == "proposed" {
		return benchcleanup.New(nil, nil)
	}
	var targets []benchworkspace.CancelRequest
	var owner *benchworkspace.Request
	for _, op := range source.Operations {
		if op.Step == "create" || op.Step == "lease" {
			original, raw, e := s.sourceRequest(spec, op.Step)
			if e != nil || digest(raw) != op.RequestSHA256 {
				return nil, ErrInvalid
			}
			target, e := benchworkspace.NewCancelRequest(original)
			if e != nil || target.TargetDigest != op.BodySHA256 {
				return nil, ErrInvalid
			}
			targets = append(targets, target)
		}
		if op.Step == "lease" || op.Step == "create" {
			var reply *benchworkspace.Response
			var e error
			if op.Phase == "observed" || op.Phase == "failed" {
				reply, e = s.observedSourceReply(spec, op)
			}
			if e != nil {
				return nil, e
			}
			if reply == nil {
				original, _, err := s.sourceRequest(spec, op.Step)
				if err != nil {
					return nil, err
				}
				c, err := benchattempt.FindCancellation(doc.Cancellations, sourceID(spec), sourceDigest(spec))
				if err != nil {
					return nil, err
				}
				reply, e = benchcleanup.HistoricalReply(s.Root, c, original)
				if errors.Is(e, ErrPending) {
					continue
				}
				if e != nil {
					return nil, e
				}
			}
			m, ok := reply.Result.(*benchworkspace.Mutation)
			if ok && m.Grant != nil {
				w := m.Workspace
				holder := spec.Holder
				if op.Step == "create" {
					holder = "initialization"
				}
				if w.Key != spec.BenchKey || w.Lease == nil || w.Lease.Holder != holder || m.RootPath != filepath.Join(spec.DataRoot, "benches", spec.BenchKey) || bound != nil && w.BenchID != bound.Plan.RegistrationID {
					return nil, ErrOwner
				}
				owner = &benchworkspace.Request{Version: benchworkspace.Version, Operation: "stop", Key: spec.BenchKey, LeaseToken: m.Grant.LeaseToken}
			}
		}
	}
	if bound != nil && (bound.Phase == "pending" || bound.Phase == "uncertain" || bound.Phase == "superseded") {
		original, _, e := s.boundRun(bound.Plan, spec)
		if e != nil {
			return nil, e
		}
		target, e := benchworkspace.NewCancelRequest(original)
		if e != nil {
			return nil, e
		}
		targets = append(targets, target)
	}
	return benchcleanup.New(targets, owner)
}

// CancellationPlan is private and opaque. Reacquire and compare it immediately
// before each transport effect; callbacks must never send while holding this lock.
func (s Store) CancellationPlan(ctx context.Context, spec SourceSpec, gate SourceGate) (*benchcleanup.Plan, error) {
	if !validSourceSpec(spec) || gate == nil {
		return nil, ErrInvalid
	}
	var plan *benchcleanup.Plan
	err := s.withDocument(ctx, spec.BenchKey, false, func(doc *state) (bool, error) {
		if gate(ctx, spec) != nil || ctx.Err() != nil {
			return false, ErrOwner
		}
		var e error
		plan, e = s.cleanupPlan(doc, spec)
		return false, e
	})
	return plan, err
}

// ObserveCleanup records producer observations only, never a release/fence proof.
func (s Store) ObserveCleanup(ctx context.Context, spec SourceSpec, plan *benchcleanup.Plan, o benchattempt.CleanupObservation) error {
	if !validSourceSpec(spec) || plan == nil || !benchattempt.ValidCleanupObservation(o) {
		return ErrInvalid
	}
	return s.withDocument(ctx, spec.BenchKey, false, func(doc *state) (bool, error) {
		current, e := s.cleanupPlan(doc, spec)
		if e != nil {
			return false, ErrConflict
		}
		if !plan.Accepts(o) || !current.Accepts(o) {
			return false, ErrInvalid
		}
		c, e := benchattempt.FindCancellation(doc.Cancellations, sourceID(spec), sourceDigest(spec))
		if e != nil {
			return false, e
		}
		for _, old := range c.Observations {
			if old == o {
				return false, nil
			}
		}
		if len(c.Observations) >= 32 {
			return false, ErrInvalid
		}
		c.Observations = append(c.Observations, o)
		return true, nil
	})
}
func (s Store) CancellationStatus(ctx context.Context, spec SourceSpec) (benchattempt.Cancellation, error) {
	var result benchattempt.Cancellation
	if !validSourceSpec(spec) {
		return result, ErrInvalid
	}
	err := s.withDocument(ctx, spec.BenchKey, false, func(doc *state) (bool, error) {
		c, e := benchattempt.FindCancellation(doc.Cancellations, sourceID(spec), sourceDigest(spec))
		if e == nil {
			result = *c
			result.Observations = append([]benchattempt.CleanupObservation(nil), c.Observations...)
			result.Exchanges = append([]benchattempt.CleanupExchange(nil), c.Exchanges...)
		}
		return false, e
	})
	return result, err
}
