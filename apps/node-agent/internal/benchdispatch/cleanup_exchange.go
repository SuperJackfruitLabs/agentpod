package benchdispatch

import (
	"context"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcleanup"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// ObserveCleanupExchange persists private transport evidence with the same lock
// as the permanent veto. No callback or response flag supplies ACK authority.
func (s Store) ObserveCleanupExchange(ctx context.Context, spec SourceSpec, plan *benchcleanup.Plan, capture *benchworkspace.ExchangeEvidence) error {
	if !validSourceSpec(spec) {
		return ErrInvalid
	}
	return s.withDocument(ctx, spec.BenchKey, false, func(doc *state) (bool, error) {
		current, e := s.cleanupPlan(doc, spec)
		if e != nil {
			return false, e
		}
		c, e := benchattempt.FindCancellation(doc.Cancellations, sourceID(spec), sourceDigest(spec))
		if e != nil {
			return false, e
		}
		changed, e := benchcleanup.ObserveExchange(s.Root, c, plan, current, capture)
		if changed && e == nil {
			doc.Version = cancellationVersion
		}
		return changed, e
	})
}

// CancellationLookupTargets is a read-only plan, never a source-body replay.
// Current authorization and independently reparsed saved ACKs are both required.
func (s Store) CancellationLookupTargets(ctx context.Context, spec SourceSpec, gate SourceGate) ([]benchworkspace.ReceiptLookupRequest, error) {
	if !validSourceSpec(spec) || gate == nil {
		return nil, ErrInvalid
	}
	var out []benchworkspace.ReceiptLookupRequest
	err := s.withDocument(ctx, spec.BenchKey, false, func(doc *state) (bool, error) {
		if gate(ctx, spec) != nil || ctx.Err() != nil {
			return false, ErrOwner
		}
		p, e := s.cleanupPlan(doc, spec)
		if e != nil {
			return false, e
		}
		c, e := benchattempt.FindCancellation(doc.Cancellations, sourceID(spec), sourceDigest(spec))
		if e != nil {
			return false, e
		}
		out, e = benchcleanup.LookupTargets(s.Root, c, p)
		return false, e
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
