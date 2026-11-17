package benchlaunch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcanonical"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// runCall rebuilds the exact bound run exchange from the journaled bytes.
func runCall(r record) (call, benchworkspace.FiniteRunRequest, error) {
	s := r.step("run")
	if s == nil || r.Binding == nil {
		return call{}, benchworkspace.FiniteRunRequest{}, benchdispatch.ErrPending
	}
	finite, err := benchworkspace.ParseFiniteRun(s.Request)
	if err != nil || digest(s.Request) != r.Binding.RequestSHA256 {
		return call{}, benchworkspace.FiniteRunRequest{}, benchdispatch.ErrInvalid
	}
	lookup, _, err := benchworkspace.FiniteTarget(finite)
	if err != nil {
		return call{}, benchworkspace.FiniteRunRequest{}, benchdispatch.ErrInvalid
	}
	return call{name: "run", path: benchworkspace.PathOperations, finite: true, growth: true, request: s.Request, lookup: &lookup}, finite, nil
}

// Execute consumes the one launch opportunity after the hub admitted the exact
// binding. The journal says "sent" before the request leaves; a lost reply is
// only ever recovered through the receipt, never by sending again.
func (c Coordinator) Execute(ctx context.Context, spec benchdispatch.SourceSpec, admit benchdispatch.AdmissionGate) (benchcoordinator.Completion, error) {
	if admit == nil {
		return benchcoordinator.Completion{}, benchdispatch.ErrInvalid
	}
	if err := c.current(ctx, spec); err != nil {
		return benchcoordinator.Completion{}, err
	}
	r, active, err := c.Journal.read(ctx, spec)
	if err != nil {
		return benchcoordinator.Completion{}, benchdispatch.ErrPending
	}
	switch {
	case r.Phase == phaseCompleted && r.Completion != nil:
		return *r.Completion, nil
	case r.Phase == phaseRefused:
		_ = c.cleanup(ctx, spec)
		return benchcoordinator.Completion{}, refuse(r.Code)
	case r.Binding == nil:
		return benchcoordinator.Completion{}, benchdispatch.ErrPending
	case !active || r.Cancelled:
		return benchcoordinator.Completion{}, refuse("stale_owner")
	}
	if admit(ctx, *r.Binding) != nil || c.current(ctx, spec) != nil {
		return benchcoordinator.Completion{}, refuse("stale_owner")
	}
	k, _, err := runCall(r)
	if err != nil {
		return benchcoordinator.Completion{}, err
	}
	if _, _, err = c.send(ctx, spec, k); err != nil {
		return benchcoordinator.Completion{}, err
	}
	return c.advance(ctx, spec)
}

// advance reads the run's reply (journaled or via the receipt), validates the
// worker result, reads the receipt back and finishes. It never sends the run.
func (c Coordinator) advance(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Completion, error) {
	var zero benchcoordinator.Completion
	r, _, err := c.Journal.read(ctx, spec)
	if err != nil {
		return zero, benchdispatch.ErrPending
	}
	if r.Phase == phaseCompleted && r.Completion != nil {
		return *r.Completion, nil
	}
	if r.Phase == phaseRefused {
		_ = c.cleanup(ctx, spec)
		return zero, refuse(r.Code)
	}
	if s := r.step("run"); s == nil || !s.Sent {
		return zero, benchdispatch.ErrPending
	}
	k, finite, err := runCall(r)
	if err != nil {
		return zero, err
	}
	status, body, err := c.send(ctx, spec, k)
	if err != nil {
		return zero, err
	}
	reply, err := benchworkspace.ParseFiniteResponse(body, status, finite)
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", true)
	}
	outcome, _ := reply.Result.(*benchworkspace.FiniteRunOutcome)
	held := outcome == nil || heldBy(spec, &outcome.Mutation)
	if !reply.OK && outcome == nil {
		code := refusalFor(reply.Error.Code)
		return zero, c.terminate(ctx, spec, code, code != "stale_owner")
	}
	if r.Cancelled {
		return zero, c.terminate(ctx, spec, "stale_owner", held)
	}
	if !reply.OK {
		return zero, c.terminate(ctx, spec, "verification_failed", held) // worker crash
	}
	b := *r.Binding
	w := outcome.Workspace
	if w.BenchID != b.BenchID || w.MemberCount != len(b.Sources) || w.CheckpointRepository != spec.CheckpointRepository || w.Phase != "ready" || !w.ReadyForAcquisition || w.Lease != nil || w.Checkpoint == nil || len(w.Checkpoint.Members) != len(b.Sources) || outcome.Execution == nil || outcome.ExitCode == nil || *outcome.ExitCode != 0 {
		return zero, c.terminate(ctx, spec, "verification_failed", false)
	}
	checkpoints := make([]benchattempt.Source, 0, len(b.Sources))
	for i, m := range w.Checkpoint.Members {
		src := b.Sources[i]
		if m.Name != src.Name || len(m.Commit) != len(src.Commit) {
			return zero, c.terminate(ctx, spec, "verification_failed", false)
		}
		src.Commit = m.Commit
		checkpoints = append(checkpoints, src)
	}
	stdout, err := outcome.IO.Stdout(*finite.IO)
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", false)
	}
	binding := superbench.Binding{BoardID: spec.Identity.BoardID, CardID: spec.Identity.CardID, RunID: spec.Identity.RunID, Epoch: spec.Identity.Epoch}
	result, err := superbench.ParseRegisteredResult(stdout, binding)
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", false)
	}
	if err = c.readback(ctx, spec, k, status, body); err != nil {
		return zero, err
	}
	receipt, err := benchcanonical.ReceiptDigest(body)
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", false)
	}
	observation := benchdispatch.Observation{RequestID: spec.RunRequestID, RequestSHA256: b.RequestSHA256, BodySHA256: b.BodySHA256, ResponseSHA256: digest(body), WorkerResultSHA256: digest(stdout[4:]), ExecutionID: outcome.Execution.ID, Stopped: true, Released: true, Checkpoints: checkpoints, Kind: "grouped-v2", GenerationID: w.Checkpoint.GenerationID, SealCommit: w.Checkpoint.Seal, ManifestSHA256: w.Checkpoint.ManifestSHA256}
	completion := benchcoordinator.Completion{Source: b, Service: observation, Task: result, SourceRequestSHA256: r.SourceSHA, SourceReceiptSHA256: receipt}
	err = c.mark(ctx, spec, func(r *record) bool {
		if r.Phase == phaseCompleted || r.Phase == phaseRefused || r.Cancelled {
			return false
		}
		r.Phase, r.Completion, r.Release = phaseCompleted, &completion, "done"
		return true
	})
	if err != nil {
		return zero, benchdispatch.ErrPending
	}
	if c.current(ctx, spec) != nil {
		return zero, refuse("stale_owner")
	}
	if done, _, e := c.Journal.read(ctx, spec); e != nil {
		return zero, benchdispatch.ErrPending
	} else if done.Phase != phaseCompleted {
		return zero, refuse("stale_owner") // cancelled while the result was being checked
	}
	return completion, nil
}

// readback independently re-reads the producer's retained receipt for the run.
// It must hold the exact bytes we captured; anything else is not our result.
func (c Coordinator) readback(ctx context.Context, spec benchdispatch.SourceSpec, k call, status int, body []byte) error {
	raw, _ := json.Marshal(k.lookup)
	got, reply, err := c.Producer.Post(ctx, benchworkspace.PathReceipts, benchworkspace.FiniteContentType, raw, benchworkspace.MaxFiniteLookup)
	if err != nil {
		return benchdispatch.ErrPending
	}
	parsed, err := benchworkspace.ParseFiniteReceiptLookupResponse(reply, got, *k.lookup)
	if err != nil || !parsed.OK {
		return benchdispatch.ErrPending
	}
	switch parsed.Result.State {
	case "completed":
		if parsed.Result.HTTPStatus == status && bytes.Equal([]byte(parsed.Result.ResponseBody), body) {
			return nil
		}
	case "in_progress", "operation_in_doubt":
		return benchdispatch.ErrPending
	}
	return c.terminate(ctx, spec, "verification_failed", false)
}

// cleanup releases a lease this attempt still holds, with its own token. It is
// token-scoped and may be repeated; it never acquires or launches anything.
func (c Coordinator) cleanup(ctx context.Context, spec benchdispatch.SourceSpec) error {
	r, _, err := c.Journal.read(ctx, spec)
	if err != nil || r.Release != "needed" {
		return err
	}
	done := func() error { return c.mark(ctx, spec, func(r *record) bool { r.Release = "done"; return true }) }
	if s := r.step("lease"); s == nil || !s.Sent {
		return done()
	}
	lease, err := c.ordinary(ctx, spec, "lease", benchworkspace.Request{Version: benchworkspace.Version, Operation: "lease", Key: spec.BenchKey, Holder: spec.Holder, RequestID: spec.LeaseRequestID}, true)
	if err != nil {
		return err
	}
	m := mutationOf(lease)
	if !lease.OK || m == nil || m.Grant == nil {
		return done()
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "release", Key: spec.BenchKey, LeaseToken: m.Grant.LeaseToken}
	reply, err := c.ordinary(ctx, spec, "release", request, true)
	if err != nil {
		var refusal *Refusal
		if errors.As(err, &refusal) && refusal.Code == "verification_failed" {
			return benchdispatch.ErrPending
		}
		return err
	}
	if reply.OK || c.leaseGone(ctx, spec) {
		return done()
	}
	return benchdispatch.ErrPending
}

// leaseGone is a read-only status check after a refused release.
func (c Coordinator) leaseGone(ctx context.Context, spec benchdispatch.SourceSpec) bool {
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "status", Key: spec.BenchKey}
	raw, _ := json.Marshal(request)
	status, body, err := c.Producer.Post(ctx, benchworkspace.PathOperations, "application/json", raw, benchworkspace.MaxResponse)
	if err != nil {
		return false
	}
	reply, err := benchworkspace.ParseResponse(body, status, request)
	inventory, ok := reply.Result.(*benchworkspace.Status)
	if err != nil || !ok || len(inventory.Benches) != 1 {
		return false
	}
	w, ok := inventory.Benches[0].(*benchworkspace.WorkspaceInventory)
	return ok && (w.Lease == nil || w.Lease.Holder != spec.Holder)
}

// Status reconciles from the journal and read-only lookups. It never sends a
// growth request; a sent run is advanced only through its receipt.
func (c Coordinator) Status(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Status, error) {
	if err := c.current(ctx, spec); err != nil {
		return benchcoordinator.Status{}, err
	}
	r, _, err := c.Journal.read(ctx, spec)
	if errors.Is(err, errAbsent) {
		return benchcoordinator.Status{State: "pending", RequiresReconciliation: true}, nil
	}
	if err != nil {
		return benchcoordinator.Status{}, benchdispatch.ErrPending
	}
	if s := r.step("run"); r.Phase == phaseRefused || r.Phase == phaseCompleted || s != nil && s.Sent {
		completion, err := c.advance(ctx, spec)
		if err == nil {
			return benchcoordinator.Status{State: "completed", Completion: &completion}, nil
		}
		if _, ok := RefusalCode(err); ok || !r.Cancelled {
			return benchcoordinator.Status{}, err
		}
		return benchcoordinator.Status{State: "cancel_requested", RequiresReconciliation: true}, nil
	}
	if r.Binding != nil && !r.Cancelled {
		p, err := prepared(r)
		return benchcoordinator.Status{State: "prepared", Source: &p}, err
	}
	return benchcoordinator.Status{State: "pending", RequiresReconciliation: true}, nil
}

// Cancel records the veto before any transport. Before launch it releases the
// lease and ends the attempt. After launch it sends one cancel for the run's
// exact target; a reply is intent only, so the attempt stays parked until the
// run's receipt is observed. The result of a cancelled run is never published.
func (c Coordinator) Cancel(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Status, error) {
	if err := c.current(ctx, spec); err != nil {
		return benchcoordinator.Status{}, err
	}
	var r record
	err := c.Journal.withRecord(ctx, spec, func(rec *record, active bool) (bool, error) {
		if !active && !rec.terminal() {
			return false, refuse("stale_owner")
		}
		raw, _ := json.Marshal(rec)
		_ = json.Unmarshal(raw, &r)
		if rec.Cancelled || rec.terminal() {
			return false, nil
		}
		rec.Cancelled, r.Cancelled = true, true
		return true, nil
	})
	if err != nil {
		return benchcoordinator.Status{}, err
	}
	if r.Phase == phaseCompleted || r.Phase == phaseRefused {
		return c.Status(ctx, spec)
	}
	run := r.step("run")
	if run == nil || !run.Sent {
		lease := r.step("lease")
		return benchcoordinator.Status{}, c.terminate(ctx, spec, "stale_owner", lease != nil && lease.Sent)
	}
	if run.Response == nil {
		_, finite, err := runCall(r)
		if err != nil {
			return benchcoordinator.Status{}, err
		}
		_, target, err := benchworkspace.FiniteTarget(finite)
		if err != nil {
			return benchcoordinator.Status{}, benchdispatch.ErrInvalid
		}
		raw, _ := json.Marshal(target)
		if status, body, err := c.send(ctx, spec, call{name: "cancel", path: benchworkspace.PathOperations, cleanup: true, request: raw}); err == nil {
			_, _ = benchworkspace.ParseCancelResponse(body, status, target) // intent only, never a fence
		}
	}
	return c.Status(ctx, spec)
}

// Reserved returns the exact spec this journal reserved for the attempt.
func (c Coordinator) Reserved(ctx context.Context, spec benchdispatch.SourceSpec) (benchdispatch.SourceSpec, error) {
	r, _, err := c.Journal.read(ctx, spec)
	if err != nil {
		return benchdispatch.SourceSpec{}, benchdispatch.ErrPending
	}
	return r.Spec, nil
}
