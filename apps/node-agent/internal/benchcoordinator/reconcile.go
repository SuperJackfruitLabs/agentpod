package benchcoordinator

import (
	"context"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcleanup"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

func (m Manager) observeExchange(spec benchdispatch.SourceSpec, plan *benchcleanup.Plan, capture *benchworkspace.ExchangeEvidence) error {
	// This context can preserve evidence only, never initiate another effect.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return m.Source.Store.ObserveCleanupExchange(ctx, spec, plan, capture)
}

// ReconcileCancellation never resends an original source or payload operation.
// Independently saved ACKs permit read-only historical lookup. A recovered token
// is used only for its exact original owner Stop, with uncertainty preserved.
func (m Manager) ReconcileCancellation(ctx context.Context, spec benchdispatch.SourceSpec) (Status, error) {
	park := Status{State: "cancel_requested", RequiresReconciliation: true}
	if e := m.current(ctx, spec); e != nil {
		return Status{}, e
	}
	targets, e := m.Source.Store.CancellationLookupTargets(ctx, spec, m.Source.Current)
	if e != nil {
		return park, e
	}
	for _, target := range targets {
		plan, e := m.Source.Store.CancellationPlan(ctx, spec, m.Source.Current)
		if e != nil {
			return park, e
		}
		o := benchattempt.CleanupObservation{Operation: "cancel", TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: "uncertain"}
		if e = m.recheck(ctx, spec, plan, o); e != nil {
			return park, e
		}
		fresh, e := m.Source.Store.CancellationLookupTargets(ctx, spec, m.Source.Current)
		if e != nil {
			return park, e
		}
		eligible := false
		for _, candidate := range fresh {
			if candidate == target {
				eligible = true
			}
		}
		if !eligible {
			return park, benchdispatch.ErrPending
		}
		_, capture, callErr := m.Source.Client.LookupReceiptWithEvidence(ctx, target)
		if capture != nil {
			if e = m.observeExchange(spec, plan, capture); e != nil {
				return park, e
			}
		}
		if callErr != nil {
			return park, benchdispatch.ErrPending
		}
	}
	plan, e := m.Source.Store.CancellationPlan(ctx, spec, m.Source.Current)
	if e != nil {
		return park, e
	}
	e = plan.Use(func(_ []benchworkspace.CancelRequest, owner *benchworkspace.Request) error {
		if owner == nil {
			return nil
		}
		digest, e := owner.Digest()
		if e != nil {
			return benchdispatch.ErrInvalid
		}
		o := benchattempt.CleanupObservation{Operation: "stop", TargetDigest: digest, State: "uncertain"}
		if e = m.recheck(ctx, spec, plan, o); e != nil {
			return e
		}
		reply, callErr := m.Source.Client.Do(ctx, *owner)
		if callErr == nil && reply != nil && reply.OK {
			o.State = "stop_observed"
		}
		if e = m.observe(spec, plan, o); e != nil {
			return e
		}
		if callErr != nil {
			return benchdispatch.ErrPending
		}
		return nil
	})
	if e != nil {
		return park, e
	}
	return m.Status(ctx, spec)
}
