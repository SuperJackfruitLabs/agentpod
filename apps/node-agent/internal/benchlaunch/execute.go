package benchlaunch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"

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
		return benchcoordinator.Completion{}, c.refusal(ctx, spec, r)
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
		return zero, c.refusal(ctx, spec, r)
	}
	if s := r.step("run"); s == nil || !s.Sent {
		return zero, benchdispatch.ErrPending
	}
	k, finite, err := runCall(r)
	if err != nil {
		return zero, err
	}
	status, body, err := c.send(ctx, spec, k)
	if errors.Is(err, errCancelBarrier) {
		return zero, c.cancelledRun(ctx, spec, r)
	}
	if err != nil {
		return zero, err
	}
	reply, err := benchworkspace.ParseFiniteResponse(body, status, finite)
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", true)
	}
	outcome, _ := reply.Result.(*benchworkspace.FiniteRunOutcome)
	held := outcome == nil || retains(spec, &outcome.Mutation)
	if !reply.OK && outcome == nil {
		code := refusalFor(reply.Error.Code)
		return zero, c.refused(ctx, spec, reply.Error, code, code != "stale_owner")
	}
	if r.Cancelled {
		return zero, c.terminate(ctx, spec, "stale_owner", held)
	}
	if !reply.OK {
		return zero, c.refused(ctx, spec, reply.Error, "verification_failed", held) // worker crash, or a refused checkpoint
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

// cancelledRun ends a record whose run lost its finalization race to a
// cancellation barrier. SuperBench stores no reply for such a run, so its
// receipt lookup answers cancel_requested for ever and no completion can ever
// come; waiting for one held the stopped lease, and the Hub's attempt, for
// ever. Treaty ("Cancellation does not release"; "A completed stored failure
// is final") leaves the lease with its holder, so the holder winds it down:
//
//   - The bench must show this record's own lease fenced (stop_requested, its
//     execution stopped), or no longer this holder's. Until it does the run may
//     still be winding down: parked, and nothing is released or stopped.
//   - The record ends refused, never completed: the result is never published.
//     A record the hub vetoed ends stale_owner (the hub's proof it retired
//     itself); one cancelled by anyone else ends verification_failed, since its
//     run did not finish.
//   - The stopped lease is released with this record's own token. No stop is
//     sent (the execution is already stopped) and nothing is checkpointed to
//     make the release succeed. A refused release keeps it held and retried.
func (c Coordinator) cancelledRun(ctx context.Context, spec benchdispatch.SourceSpec, r record) error {
	w := c.bench(ctx, spec)
	if w == nil {
		return errCancelBarrier
	}
	gone := w.Lease == nil || w.Lease.Holder != spec.Holder || r.BenchID != "" && w.BenchID != r.BenchID
	stopped := !gone && w.Lease.StopRequested && w.Lease.Execution != nil && w.Lease.Execution.Phase == "stopped"
	if !gone && !stopped {
		return errCancelBarrier
	}
	code := "verification_failed"
	if r.Cancelled {
		code = "stale_owner"
	}
	log.Printf("bench %s: run %s was cancelled before its receipt was stored; ending the attempt %s and releasing its stopped lease", spec.BenchKey, spec.RunRequestID, code)
	return c.terminate(ctx, spec, code, !gone)
}

// refusal is the record's terminal refusal as the journal now holds it (a
// cleanup may have just recorded a refused release), or fallback's.
func (c Coordinator) refusal(ctx context.Context, spec benchdispatch.SourceSpec, fallback record) error {
	if r, _, err := c.Journal.read(ctx, spec); err == nil && r.Phase == phaseRefused {
		return refusalOf(r)
	}
	return refusalOf(fallback)
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
		// An unresolved lease reply normally parks. The generation the lease
		// was requested on, once reclaiming or reclaimed, proves no lease is
		// held there, so the old attempt's lease is recorded as gone instead
		// of blocking the key. Any other generation keeps it parked: a late
		// grant may land there, and the receipt lookup that finds it releases
		// it below with its own token.
		if c.reclaimed(ctx, spec, r.BenchID) {
			return done()
		}
		return err
	}
	m := mutationOf(lease)
	if !lease.OK || m == nil || m.Grant == nil {
		return done()
	}
	id := m.Workspace.BenchID
	if _, err = c.granted(ctx, spec, id); err != nil {
		return err
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "release", Key: spec.BenchKey, LeaseToken: m.Grant.LeaseToken}
	reply, err := c.ordinary(ctx, spec, "release", request, true)
	if err != nil {
		var refusal *Refusal
		if !errors.As(err, &refusal) || refusal.Code != "verification_failed" {
			return err // lost or fenced: the step is kept or the record is not ours
		}
	}
	if err == nil && reply.OK || c.leaseGone(ctx, spec, id) {
		return done()
	}
	if err == nil {
		if message := producerMessage(reply.Error); message != "" {
			_ = c.mark(ctx, spec, func(r *record) bool { r.ReleaseRefusal = message; return true })
		}
	}
	// A refused or malformed reply while we still hold the lease. Release is
	// token-scoped and repeatable, so drop the saved reply and send it again
	// next time; never replay a bad answer forever.
	c.forget(ctx, spec, "release")
	c.releaseFailed(ctx, spec)
	return benchdispatch.ErrPending
}

// releaseWarnAfter is how many failed releases pass before each further
// failure is logged; the attempt keeps retrying regardless.
const releaseWarnAfter = 3

func (c Coordinator) releaseFailed(ctx context.Context, spec benchdispatch.SourceSpec) {
	failures, message := 0, ""
	_ = c.mark(ctx, spec, func(r *record) bool {
		r.ReleaseFailures++
		failures, message = r.ReleaseFailures, r.ReleaseRefusal
		return true
	})
	// Said on every refusal: once the hub has ended the attempt, nothing but
	// the card's next attempt retries this release, so an earlier silence
	// left a held lease with no trace. The refusal (a dirty tree, for one)
	// does not clear itself; docs/BENCH_REGISTERED_LAUNCH.md, "A refused
	// release", names the supported operator path.
	log.Printf("bench %s: release refused (%d) while the lease is still held: %q; operator attention needed: bench workspace stop_admin, then a root bench workspace run with the returned token that fixes the tree and checkpoints, then release", spec.BenchKey, failures, message)
}

// releaseStuck reports a record whose release keeps failing, so Status can
// say so instead of a plain cancel_requested.
func releaseStuck(r record) bool {
	return r.Release == "needed" && r.ReleaseFailures >= releaseWarnAfter
}

// leaseGone is a read-only status check after a refused release of the grant
// on generation id. On that generation, the lease is gone when it is no longer
// ours. A status read is never older than the grant it follows, so a different
// bench_id is a later generation: SuperBench creates one only once the grant's
// generation is reclaimed, and reclaims only a released bench, so the grant is
// gone. An unknown generation proves nothing.
func (c Coordinator) leaseGone(ctx context.Context, spec benchdispatch.SourceSpec, id string) bool {
	w := c.bench(ctx, spec)
	if w == nil || id == "" {
		return false
	}
	return w.BenchID != id || w.Lease == nil || w.Lease.Holder != spec.Holder
}

// reclaimed is a read-only status check: SuperBench reclaims only a released,
// idle bench, so generation id, once reclaiming or reclaimed, holds no lease of
// ours. A record with no generation proves nothing and stays parked.
func (c Coordinator) reclaimed(ctx context.Context, spec benchdispatch.SourceSpec, id string) bool {
	w := c.bench(ctx, spec)
	return w != nil && id != "" && w.BenchID == id && benchworkspace.Reclaim(w.Phase)
}

// bench reads the key's one workspace from a status reply, or nil. A key
// SuperBench answers not_found for is nil too, on purpose: every caller reads
// nil as "proves nothing" (no generation pinned, lease not shown gone, not
// reclaimed). After a grant, absence could be a purged record as easily as a
// never-made one, so it never stands in for a reclaimed generation.
func (c Coordinator) bench(ctx context.Context, spec benchdispatch.SourceSpec) *benchworkspace.WorkspaceInventory {
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "status", Key: spec.BenchKey}
	raw, _ := json.Marshal(request)
	status, body, err := c.Producer.Post(ctx, benchworkspace.PathOperations, "application/json", raw, benchworkspace.MaxResponse)
	if err != nil {
		return nil
	}
	reply, err := benchworkspace.ParseResponse(body, status, request)
	inventory, ok := reply.Result.(*benchworkspace.Status)
	if err != nil || !ok || len(inventory.Benches) != 1 {
		return nil
	}
	w, _ := inventory.Benches[0].(*benchworkspace.WorkspaceInventory)
	return w
}

// Status reconciles from the journal and read-only lookups. It never sends a
// growth request; a sent run is advanced only through its receipt.
func (c Coordinator) Status(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Status, error) {
	if c.Current == nil {
		return benchcoordinator.Status{}, refuse("stale_owner")
	}
	if err := c.Current(ctx, spec); errors.Is(err, ErrSuperseded) {
		return c.retired(ctx, spec)
	} else if err != nil || ctx.Err() != nil {
		// A current check that failed (a slow or unreachable hub) proves
		// nothing. It stays parked: stale_owner is the hub's proof that this
		// record retired itself, and only ErrSuperseded may say it.
		return benchcoordinator.Status{}, benchdispatch.ErrPending
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
		if after, _, e := c.Journal.read(ctx, spec); e == nil && leaseHeld(after) {
			return benchcoordinator.Status{State: "release_refused", RequiresReconciliation: true, LeaseHeld: true, Message: after.ReleaseRefusal}, nil
		}
		return benchcoordinator.Status{State: "cancel_requested", RequiresReconciliation: true}, nil
	}
	if r.Binding != nil && !r.Cancelled {
		p, err := prepared(r)
		return benchcoordinator.Status{State: "prepared", Source: &p}, err
	}
	if r.Parked != "" && !r.Cancelled {
		return benchcoordinator.Status{State: r.Parked, RequiresReconciliation: true}, nil
	}
	return benchcoordinator.Status{State: "pending", RequiresReconciliation: true}, nil
}

// ErrLaunched refuses RetireUnlaunched: this record sent its run (even one
// whose reply was lost), so retiring it here could not prove nothing ran.
var ErrLaunched = errors.New("registered attempt sent its run; not retired without a run receipt")

// RetireUnlaunched retires this exact record only while it provably launched
// nothing. Under the bench lock it refuses a record whose run was sent, and
// otherwise journals the veto first, so no run can be sent after it. Then it
// winds down as retire does: release the lease the record holds with its own
// token, mark the record stale_owner. A record already terminal answers its
// own code; an absent one is errAbsent.
func (c Coordinator) RetireUnlaunched(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Status, error) {
	err := c.Journal.withRecord(ctx, spec, func(rec *record, active bool) (bool, error) {
		if run := rec.step("run"); run != nil && run.Sent {
			return false, ErrLaunched
		}
		if rec.terminal() || !active || rec.Cancelled {
			return false, nil
		}
		rec.Cancelled = true
		return true, nil
	})
	if err != nil {
		return benchcoordinator.Status{}, err
	}
	return c.retired(ctx, spec)
}

// Cancel ends this exact attempt. It is authorised by the journal record's
// identity (the same reserved spec), not by a current decision, so a node can
// clean up after a decision that has already moved on. See retire.
func (c Coordinator) Cancel(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Status, error) {
	return c.retired(ctx, spec)
}

func (c Coordinator) retired(ctx context.Context, spec benchdispatch.SourceSpec) (benchcoordinator.Status, error) {
	err := c.retire(ctx, spec)
	if errors.Is(err, benchdispatch.ErrPending) {
		status := benchcoordinator.Status{State: "cancel_requested", RequiresReconciliation: true}
		if r, _, e := c.Journal.read(ctx, spec); e == nil && leaseHeld(r) {
			status.LeaseHeld, status.Message = true, r.ReleaseRefusal
			if releaseStuck(r) {
				status.State = "release_refused" // the lease is still held and its release keeps failing
			}
		}
		return status, nil
	}
	if errors.Is(err, errAbsent) {
		return benchcoordinator.Status{}, refuse("stale_owner")
	}
	return benchcoordinator.Status{}, err
}

// retire vetoes this record before any transport and winds it down without
// ever sending or resending a run. Before launch it releases the lease the
// record holds and ends the attempt. After launch it sends one cancel for the
// run's exact target (intent only) and stays parked until the run's receipt is
// observed; that result is never published. Release is token-scoped and treats
// a lease already gone as success.
func (c Coordinator) retire(ctx context.Context, spec benchdispatch.SourceSpec) error {
	var r record
	err := c.Journal.withRecord(ctx, spec, func(rec *record, active bool) (bool, error) {
		raw, _ := json.Marshal(rec)
		_ = json.Unmarshal(raw, &r)
		if rec.terminal() {
			return false, nil
		}
		if !active {
			return false, refuse("stale_owner")
		}
		if rec.Cancelled {
			return false, nil
		}
		// The veto also covers refused and completed records whose lease is
		// still held: it is what lets their release go out without a current
		// decision. It never authorises a run.
		rec.Cancelled, r.Cancelled = true, true
		return true, nil
	})
	if err != nil {
		return err
	}
	if r.terminal() {
		if r.Phase == phaseCompleted {
			return refuse("stale_owner")
		}
		return refusalOf(r)
	}
	if r.Phase == phaseCompleted || r.Phase == phaseRefused {
		if e := c.cleanup(ctx, spec); e != nil {
			return e
		}
		if after, _, e := c.Journal.read(ctx, spec); e == nil && after.Release == "needed" {
			return benchdispatch.ErrPending
		}
		if r.Phase == phaseCompleted {
			return refuse("stale_owner") // a completed result is not re-published to a stale caller
		}
		return c.refusal(ctx, spec, r)
	}
	run := r.step("run")
	if run == nil || !run.Sent {
		lease := r.step("lease")
		err = c.terminate(ctx, spec, "stale_owner", lease != nil && lease.Sent)
		if after, _, e := c.Journal.read(ctx, spec); e == nil && after.Release == "needed" {
			return benchdispatch.ErrPending
		}
		return err
	}
	if run.Response == nil {
		_, finite, err := runCall(r)
		if err != nil {
			return err
		}
		_, target, err := benchworkspace.FiniteTarget(finite)
		if err != nil {
			return benchdispatch.ErrInvalid
		}
		raw, _ := json.Marshal(target)
		sent := r.step("cancel") == nil || r.step("cancel").Response == nil
		state := "unanswered"
		if status, body, err := c.send(ctx, spec, call{name: "cancel", path: benchworkspace.PathOperations, cleanup: true, request: raw}); err == nil {
			if reply, e := benchworkspace.ParseCancelResponse(body, status, target); e == nil && reply.OK && reply.Result != nil {
				state = reply.Result.State // intent only, never a fence
			}
		}
		if sent {
			log.Printf("bench %s: hub retired run %s; cancel requested (%s), waiting for the run to stop", spec.BenchKey, spec.RunRequestID, state)
		}
	}
	_, err = c.advance(ctx, spec)
	if err == nil {
		return refuse("stale_owner")
	}
	if after, _, e := c.Journal.read(ctx, spec); e == nil && after.Release == "needed" {
		return benchdispatch.ErrPending
	}
	return err
}

// supersede retires an older attempt on the same card that still owns the
// bench. It runs only for a spec whose own decision is current, which is the
// hub's statement that the older attempt no longer is.
func (c Coordinator) supersede(ctx context.Context, spec benchdispatch.SourceSpec) error {
	var old *benchdispatch.SourceSpec
	err := c.Journal.update(ctx, spec.BenchKey, func(doc *document) (bool, error) {
		for i := range doc.Records {
			r := doc.Records[i]
			if r.ID == doc.Active && r.ID != recordID(spec) && !r.terminal() {
				o := r.Spec.Identity
				n := spec.Identity
				if o.TenantID == n.TenantID && o.BoardID == n.BoardID && o.CardID == n.CardID {
					old = &r.Spec
				}
			}
		}
		return false, nil
	})
	if err != nil || old == nil {
		return err
	}
	err = c.retire(ctx, *old)
	// Only a terminal record frees the bench: while the older one still holds
	// its lease (or its run is unresolved) the newer attempt waits, retryable.
	r, _, e := c.Journal.read(ctx, *old)
	if e == nil && r.terminal() {
		return nil
	}
	if e == nil && leaseHeld(r) {
		// The older record's release is refused: the newer attempt waits on
		// an operator, and says so.
		return &HeldLease{Message: r.ReleaseRefusal}
	}
	if err == nil || isRefusalErr(err) {
		return benchdispatch.ErrPending
	}
	return err
}

func isRefusalErr(err error) bool { _, ok := RefusalCode(err); return ok }

// Reserved returns the exact spec this journal reserved for the attempt.
func (c Coordinator) Reserved(ctx context.Context, spec benchdispatch.SourceSpec) (benchdispatch.SourceSpec, error) {
	r, _, err := c.Journal.read(ctx, spec)
	if err != nil {
		return benchdispatch.SourceSpec{}, benchdispatch.ErrPending
	}
	return r.Spec, nil
}
