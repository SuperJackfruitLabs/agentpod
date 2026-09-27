package hermeslive

import (
	"errors"
	"fmt"
	"time"
)

// Operator runs plugin operations for one profile. Gate is asked afresh for
// each enable plan and again at apply, so a Hermes upgraded in between is
// reviewed again rather than trusted.
type Operator struct {
	ProfileDir string
	Binding    OperationBinding
	Gate       func() Gate
	Now        func() time.Time
}

func (o Operator) stamp() string { return o.Now().UTC().Format(time.RFC3339Nano) }

func (o Operator) plan(id, action, createdAt string) (OperationPlan, Plan, error) {
	var plan Plan
	var gate *Gate
	var err error
	switch action {
	case "enable":
		g := o.Gate()
		gate = &g
		plan, err = PlanEnable(o.ProfileDir, g, false)
	case "disable":
		plan, err = PlanDisable(o.ProfileDir)
	default:
		return OperationPlan{}, plan, fmt.Errorf("hermes-live: unknown plugin action %q", action)
	}
	return NewOperationPlan(o.Binding, id, action, gate, plan, err, createdAt), plan, nil
}

// Plan records a reviewed plan for id, or returns the one already recorded.
// A refusal is recorded too, as a conflict naming the reason.
func (o Operator) Plan(id, action string) (OperationPlan, error) {
	journal := OpenJournal(o.ProfileDir)
	defer journal.Lock()()
	if existing, err := journal.Read(id); err == nil {
		if existing.Plan.Action != action || existing.Plan.Binding != o.Binding {
			return OperationPlan{}, fmt.Errorf("hermes-live: operation %s already holds a different plan", id)
		}
		return existing.Plan, nil
	} else if !errors.Is(err, ErrOperationNotFound) {
		return OperationPlan{}, err
	}
	now := o.stamp()
	op, _, err := o.plan(id, action, now)
	if err != nil {
		return op, err
	}
	receipt := OperationReceipt{Plan: op, Phase: "planned", UpdatedAt: now}
	if op.Refusal != nil {
		receipt.Phase, receipt.Error = "conflict", op.Refusal
	}
	return op, journal.Write(receipt)
}

// Inspect returns the journal's receipt for id, or ErrOperationNotFound.
func (o Operator) Inspect(id string) (OperationReceipt, error) {
	return OpenJournal(o.ProfileDir).Read(id)
}

// Apply carries out the plan reviewed under expectedDigest. It plans again
// and applies only if the new plan is the reviewed one: a profile that changed
// since the review yields a conflict, never a different change.
func (o Operator) Apply(id, expectedDigest string) (OperationReceipt, error) {
	journal := OpenJournal(o.ProfileDir)
	defer journal.Lock()()
	receipt, err := journal.Read(id)
	if err != nil {
		return receipt, err
	}
	if receipt.Plan.PlanDigest != expectedDigest {
		return receipt, fmt.Errorf("%w: the reviewed plan digest differs from this operation's", ErrConflict)
	}
	if receipt.Plan.Binding != o.Binding {
		return receipt, fmt.Errorf("hermes-live: operation %s belongs to another station or plugin", id)
	}
	switch receipt.Phase {
	case "applied", "conflict":
		return receipt, nil
	case "applying":
		// A previous apply began and did not record its end. The change is
		// all-or-nothing only per file, so say what the profile holds now.
		return o.settle(journal, receipt)
	}
	current, plan, err := o.plan(id, receipt.Plan.Action, receipt.Plan.CreatedAt)
	if err != nil {
		return receipt, err
	}
	if current.PlanDigest != receipt.Plan.PlanDigest {
		return o.finish(journal, receipt, "conflict", "the profile changed after the plan was reviewed; plan again")
	}
	receipt.Phase, receipt.UpdatedAt = "applying", o.stamp()
	if err := journal.Write(receipt); err != nil {
		return receipt, err
	}
	if err := Apply(plan, o.Now()); err != nil {
		if errors.Is(err, ErrConflict) {
			return o.finish(journal, receipt, "conflict", err.Error())
		}
		return receipt, err
	}
	return o.finish(journal, receipt, "applied", "")
}

// settle decides an interrupted apply from what the profile holds: enabled
// and current after an enable, or no apn record after a disable, means it
// finished. Anything else is left as a conflict for the operator to review.
func (o Operator) settle(journal Journal, receipt OperationReceipt) (OperationReceipt, error) {
	done := false
	switch receipt.Plan.Action {
	case "enable":
		plan, err := PlanEnable(o.ProfileDir, Gate{Allowed: true}, false)
		done = err == nil && plan.NoOp
	case "disable":
		state, err := readState(o.ProfileDir)
		done = err == nil && state == nil
	}
	if done {
		return o.finish(journal, receipt, "applied", "")
	}
	return o.finish(journal, receipt, "conflict", "an earlier apply was interrupted and the profile is not in the planned state; review it and plan again")
}

func (o Operator) finish(journal Journal, receipt OperationReceipt, phase, reason string) (OperationReceipt, error) {
	now := o.stamp()
	receipt.Phase, receipt.UpdatedAt, receipt.Error = phase, now, nil
	if phase == "applied" {
		receipt.CompletedAt = &now
	} else {
		bounded := boundedReason(reason)
		receipt.Error = &bounded
	}
	return receipt, journal.Write(receipt)
}
