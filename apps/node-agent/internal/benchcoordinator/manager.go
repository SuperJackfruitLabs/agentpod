package benchcoordinator

import (
	"context"
	"errors"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcleanup"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// Manager is a private host-local orchestration boundary, not a registered node
// verb. Current/admission still require separately authenticated Hub wiring.
type Manager struct {
	Source benchdispatch.SourceCoordinator
}

type Prepared struct {
	Binding              benchdispatch.SourceBinding `json:"binding"`
	BindingSHA256        string                      `json:"binding_sha256"`
	RequestID            string                      `json:"request_id"`
	CheckpointRepository string                      `json:"checkpoint_repository"`
}
type Status struct {
	State                  string                            `json:"state"`
	Source                 *Prepared                         `json:"source,omitempty"`
	Completion             *Completion                       `json:"completion,omitempty"`
	Observations           []benchattempt.CleanupObservation `json:"observations,omitempty"`
	RequiresReconciliation bool                              `json:"requires_reconciliation,omitempty"`
}

func prepared(b benchdispatch.SourceBinding, spec benchdispatch.SourceSpec) Prepared {
	return Prepared{Binding: b, BindingSHA256: benchdispatch.SourceBindingSHA256(b), RequestID: spec.RunRequestID, CheckpointRepository: spec.CheckpointRepository}
}
func (m Manager) current(ctx context.Context, spec benchdispatch.SourceSpec) error {
	if m.Source.Client == nil || m.Source.Current == nil {
		return benchdispatch.ErrInvalid
	}
	if ctx.Err() != nil || m.Source.Current(ctx, spec) != nil || ctx.Err() != nil {
		return benchdispatch.ErrOwner
	}
	return nil
}
func (m Manager) Prepare(ctx context.Context, spec benchdispatch.SourceSpec, task benchdispatch.SourceTask) (Prepared, error) {
	if e := m.current(ctx, spec); e != nil {
		return Prepared{}, e
	}
	if _, e := m.Source.Prepare(ctx, spec, task); e != nil {
		return Prepared{}, e
	}
	b, e := m.Source.Binding(ctx, spec)
	if e != nil {
		return Prepared{}, e
	}
	if e = m.current(ctx, spec); e != nil {
		return Prepared{}, e
	}
	return prepared(b, spec), nil
}
func (m Manager) Execute(ctx context.Context, spec benchdispatch.SourceSpec, admit benchdispatch.AdmissionGate) (Completion, error) {
	if e := m.current(ctx, spec); e != nil {
		return Completion{}, e
	}
	if _, e := m.Source.ExecuteBound(ctx, spec, admit); e != nil {
		return Completion{}, e
	}
	c, e := ReadCompletion(ctx, m.Source.Store, spec)
	if e != nil {
		return Completion{}, e
	}
	if m.current(ctx, spec) != nil || admit == nil || admit(ctx, c.Source) != nil || m.current(ctx, spec) != nil {
		return Completion{}, benchdispatch.ErrOwner
	}
	if _, e = m.Source.Store.CancellationStatus(ctx, spec); e == nil {
		return Completion{}, benchdispatch.ErrOwner
	} else if !errors.Is(e, benchdispatch.ErrOwner) {
		return Completion{}, e
	}
	return c, nil
}

// Status reads/reconciles preserved local evidence only. It never sends a growth
// operation, refreshes a grant or converts absence of a lease into completion.
func (m Manager) Status(ctx context.Context, spec benchdispatch.SourceSpec) (Status, error) {
	if e := m.current(ctx, spec); e != nil {
		return Status{}, e
	}
	if marker, e := m.Source.Store.CancellationStatus(ctx, spec); e == nil {
		if e = m.current(ctx, spec); e != nil {
			return Status{}, e
		}
		return Status{State: "cancel_requested", Observations: marker.Observations, RequiresReconciliation: true}, nil
	} else if !errors.Is(e, benchdispatch.ErrOwner) {
		return Status{}, e
	}
	c, e := ReadCompletion(ctx, m.Source.Store, spec)
	if e == nil {
		if e = m.current(ctx, spec); e != nil {
			return Status{}, e
		}
		return Status{State: "completed", Completion: &c}, nil
	}
	if !errors.Is(e, benchdispatch.ErrPending) && !errors.Is(e, benchdispatch.ErrOwner) {
		return Status{}, e
	}
	if _, e = m.Source.Store.BoundSource(ctx, spec); e == nil {
		b, e := m.Source.Binding(ctx, spec)
		if e != nil {
			return Status{}, e
		}
		p := prepared(b, spec)
		if e = m.current(ctx, spec); e != nil {
			return Status{}, e
		}
		return Status{State: "prepared", Source: &p}, nil
	} else if !errors.Is(e, benchdispatch.ErrPending) {
		return Status{}, e
	}
	if e = m.current(ctx, spec); e != nil {
		return Status{}, e
	}
	return Status{State: "pending", RequiresReconciliation: true}, nil
}

// Cancel persists the veto before transport, then targets only preserved original
// operation IDs/digests and the original private owner token. It does not infer
// fencing, checkpoint/release success or permission to redispatch from replies.
func (m Manager) Cancel(ctx context.Context, spec benchdispatch.SourceSpec) (Status, error) {
	if e := m.current(ctx, spec); e != nil {
		return Status{}, e
	}
	if e := m.Source.Store.BeginCancellation(ctx, spec, m.Source.Current); e != nil {
		return Status{}, e
	}
	plan, e := m.Source.Store.CancellationPlan(ctx, spec, m.Source.Current)
	if e != nil {
		return Status{}, e
	}
	e = plan.Use(func(targets []benchworkspace.CancelRequest, owner *benchworkspace.Request) error {
		for _, target := range targets {
			observation := benchattempt.CleanupObservation{Operation: "cancel", TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: "uncertain"}
			if e := m.recheck(ctx, spec, plan, observation); e != nil {
				return e
			}
			reply, callErr := m.Source.Client.Cancel(ctx, target)
			if callErr == nil && reply != nil && reply.Result != nil {
				observation.State = reply.Result.State
			}
			if e := m.observe(spec, plan, observation); e != nil {
				return e
			}
			if callErr != nil {
				return benchdispatch.ErrPending
			}
		}
		if owner != nil {
			digest, e := owner.Digest()
			if e != nil {
				return benchdispatch.ErrInvalid
			}
			observation := benchattempt.CleanupObservation{Operation: "stop", TargetDigest: digest, State: "uncertain"}
			if e = m.recheck(ctx, spec, plan, observation); e != nil {
				return e
			}
			reply, callErr := m.Source.Client.Do(ctx, *owner)
			if callErr == nil && reply != nil && reply.OK {
				observation.State = "stop_observed"
			}
			if e = m.observe(spec, plan, observation); e != nil {
				return e
			}
			if callErr != nil {
				return benchdispatch.ErrPending
			}
		}
		return nil
	})
	if e != nil {
		return Status{State: "cancel_requested", RequiresReconciliation: true}, e
	}
	return m.Status(ctx, spec)
}
func (m Manager) recheck(ctx context.Context, spec benchdispatch.SourceSpec, plan *benchcleanup.Plan, o benchattempt.CleanupObservation) error {
	if e := m.current(ctx, spec); e != nil {
		return e
	}
	current, e := m.Source.Store.CancellationPlan(ctx, spec, m.Source.Current)
	if e != nil {
		return e
	}
	if !plan.Accepts(o) || !current.Accepts(o) {
		return benchdispatch.ErrConflict
	}
	return nil
}
func (m Manager) observe(spec benchdispatch.SourceSpec, plan *benchcleanup.Plan, o benchattempt.CleanupObservation) error {
	// Evidence-only independent context cannot issue another transport request.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return m.Source.Store.ObserveCleanup(ctx, spec, plan, o)
}
