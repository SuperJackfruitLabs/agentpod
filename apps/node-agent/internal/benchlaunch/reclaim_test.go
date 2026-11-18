package benchlaunch

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// reclaimedAttempt is the next attempt on a card whose bench SuperBench has
// reclaimed: the bridge chose create for the same key.
func reclaimedAttempt(spec benchdispatch.SourceSpec) benchdispatch.SourceSpec {
	next := nextAttempt(spec)
	next.Create, next.CreateRequestID = true, "create_y"
	return next
}

// A finished attempt released its bench and SuperBench reclaimed it. The next
// attempt creates the same key once, and a retry of that prepare, even after
// a lost create reply, never creates twice.
func TestReclaimedBenchIsCreatedOnceForTheNextAttempt(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); err != nil {
		t.Fatal(err)
	}
	tr.reclaim = "reclaimed"
	next := reclaimedAttempt(tr.spec)
	tr.current.Store(&next)
	tr.loseAfter["create"] = true
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("a lost create reply did not park", err)
	}
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("prepare after reclaim failed", err)
	}
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("prepare retry failed", err)
	}
	if tr.count(tr.effects, "create") != 1 || tr.count(tr.posts, "create") != 1 || tr.count(tr.effects, "lease") != 2 {
		t.Fatal("reclaimed bench was not created exactly once", tr.count(tr.posts, "create"), tr.count(tr.effects, "create"))
	}
	if _, err := tr.c.Execute(context.Background(), next, admitAll); err != nil {
		t.Fatal("fresh bench did not run", err)
	}
}

// The older attempt released, but its release reply was lost, so its record
// still says the lease needs releasing. SuperBench then reclaimed the bench.
// The record must learn the lease is gone instead of holding the key forever.
func TestReclaimedBenchRecordsTheOldLeaseAsGone(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.capacity["run"], tr.loseAfter["release"] = true, true
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "capacity_exhausted")
	delete(tr.capacity, "run")
	if r, _ := tr.record(t, tr.spec); r.Release != "needed" || tr.leased {
		t.Fatal("fixture: the release should have acted with its reply lost", r.Release, tr.leased)
	}
	tr.reclaim = "reclaimed"
	next := reclaimedAttempt(tr.spec)
	tr.current.Store(&next)
	if _, err = tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("the old record kept the reclaimed bench leased", err)
	}
	if old, active := tr.record(t, tr.spec); !old.terminal() || active || old.Release != "done" || tr.count(tr.effects, "create") != 1 {
		t.Fatal("old lease not recorded as gone", old.Release, active)
	}
}

// The older attempt's lease request never reached the producer and has no
// receipt, so it can never resolve. A reclaimed bench proves no lease is held.
func TestReclaimedBenchResolvesAnUnansweredOldLease(t *testing.T) {
	tr := newTrial(t)
	tr.loseBefore["lease"] = true
	tr.lookup = "absent"
	if _, err := tr.c.Prepare(context.Background(), tr.spec, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("fixture: the lease should be unanswered", err)
	}
	if r, _ := tr.record(t, tr.spec); r.BenchID != tr.benchID {
		t.Fatal("the lease's generation was not recorded before it was sent", r.BenchID)
	}
	tr.reclaim = "reclaimed"
	next := reclaimedAttempt(tr.spec)
	tr.current.Store(&next)
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("unanswered old lease kept the reclaimed bench", err)
	}
	if old, active := tr.record(t, tr.spec); !old.terminal() || active || old.Release != "done" {
		t.Fatal("old lease not recorded as gone", old.Phase, old.Release, active)
	}
	if tr.count(tr.effects, "create") != 1 || tr.count(tr.effects, "lease") != 1 {
		t.Fatal("reclaimed bench not created exactly once")
	}
}

// While SuperBench is still reclaiming, a status read of the bench parses and
// shows no lease, so the old record's pending release finishes.
func TestReclaimingBenchFinishesTheOldRelease(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.capacity["run"], tr.loseAfter["release"] = true, true
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "capacity_exhausted")
	tr.reclaim = "reclaiming"
	if _, err = tr.c.Cancel(context.Background(), tr.spec); !isRefusal(err, "capacity_exhausted") {
		t.Fatal("old record did not finish", err)
	}
	if old, _ := tr.record(t, tr.spec); !old.terminal() || tr.count(tr.posts, "create") != 0 {
		t.Fatal("reclaiming bench kept the old lease or was created", old.Release)
	}
}

// unansweredLease leaves the attempt's lease request sent, with no reply and
// no receipt, and retires the attempt so its record needs a release.
func unansweredLease(t *testing.T, tr *trial) {
	t.Helper()
	tr.loseBefore["lease"] = true
	tr.lookup = "absent"
	if _, err := tr.c.Prepare(context.Background(), tr.spec, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("fixture: the lease should be unanswered", err)
	}
}

// parked asserts Cancel leaves the record holding the key with its release
// still needed: nothing proved the lease gone.
func parked(t *testing.T, tr *trial, why string) {
	t.Helper()
	st, err := tr.c.Cancel(context.Background(), tr.spec)
	if err != nil || st.State != "cancel_requested" {
		t.Fatal(why, st.State, err)
	}
	if r, active := tr.record(t, tr.spec); r.terminal() || !active || r.Release != "needed" {
		t.Fatal(why, r.Phase, r.Release, active)
	}
}

// A later generation's reclaim says nothing about where the old lease request
// went: it may still land on the generation after. The record stays parked,
// and when the late grant shows up in the receipt it is released with the new
// bench's own token.
func TestOtherGenerationReclaimKeepsTheOldLeaseUntilItsLateGrantIsReleased(t *testing.T) {
	tr := newTrial(t)
	unansweredLease(t, tr)
	first := tr.benchID
	// Out of band, the key was reclaimed, created again and reclaimed again.
	tr.benchID, tr.reclaim = strings.Repeat("7", 32), "reclaimed"
	parked(t, tr, "a different generation's reclaim marked the old lease gone")
	next := nextAttempt(tr.spec)
	tr.current.Store(&next)
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, benchdispatch.ErrPending) || tr.count(tr.posts, "lease") != 1 {
		t.Fatal("a newer attempt took the key while the old lease was unresolved", err)
	}
	// The key's next generation is ready, and the old request finally arrives.
	tr.benchID, tr.reclaim, tr.lookup = strings.Repeat("8", 32), "", ""
	old, _ := tr.record(t, tr.spec)
	if _, _, err := tr.Post(context.Background(), benchworkspace.PathOperations, "application/json", old.step("lease").Request, benchworkspace.MaxResponse); err != nil || !tr.leased || tr.holder != tr.spec.Holder {
		t.Fatal("fixture: the late lease should be granted", err)
	}
	tr.current.Store(&tr.spec)
	if _, err := tr.c.Cancel(context.Background(), tr.spec); !isRefusal(err, "stale_owner") {
		t.Fatal("the late grant was not released", err)
	}
	r, active := tr.record(t, tr.spec)
	if !r.terminal() || active || r.Release != "done" || r.BenchID != tr.benchID || r.BenchID == first || tr.leased || tr.count(tr.effects, "release") != 1 {
		t.Fatal("the late grant on the new generation is still held", r.Release, r.BenchID, tr.leased)
	}
}

// The bench was reclaimed and created again between the status read that
// recorded the generation and the lease. The grant is on a generation this
// attempt was not prepared for: refused, and released with its own token.
func TestLeaseGrantedOnAnotherGenerationIsRefusedAndReleased(t *testing.T) {
	tr := newTrial(t)
	tr.afterStatus = func() {
		tr.afterStatus = nil
		tr.benchID = strings.Repeat("9", 32)
	}
	_, err := tr.c.Prepare(context.Background(), tr.spec, tr.task)
	wantCode(t, err, "stale_owner")
	r, _ := tr.record(t, tr.spec)
	if !r.terminal() || r.Release != "done" || r.BenchID != tr.benchID || tr.leased || tr.count(tr.effects, "release") != 1 || tr.count(tr.posts, "checkpoint") != 0 {
		t.Fatal("a grant on another generation was used or kept", r.Phase, r.Release, r.BenchID, tr.leased)
	}
}

// A record written before generations were kept has no bench_id. A reclaim
// phase alone cannot say which generation it is, so the record stays parked,
// as it did before reclaims were understood, rather than risk leaking a late
// grant on a new generation. A retried prepare does not adopt the generation a
// status read shows now: the lease may have been sent to an earlier one.
func TestRecordWithoutAGenerationIsNotGoneOnReclaim(t *testing.T) {
	tr := newTrial(t)
	unansweredLease(t, tr)
	if err := tr.c.mark(context.Background(), tr.spec, func(r *record) bool { r.BenchID = ""; return true }); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.c.Prepare(context.Background(), tr.spec, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("fixture: the lease should stay unanswered", err)
	}
	if r, _ := tr.record(t, tr.spec); r.BenchID != "" {
		t.Fatal("a sent lease adopted a generation it may not have been sent to", r.BenchID)
	}
	tr.reclaim = "reclaimed"
	parked(t, tr, "a record without a generation took a reclaim as proof")
}

// A refused release, then a status read showing a later generation: SuperBench
// creates one only after the grant's generation is reclaimed, which needs a
// released bench, so the grant is gone. The same generation still held by us
// is not.
func TestRefusedReleaseIsGoneOnALaterGeneration(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.refuseRelease = 1
	parked(t, tr, "a refused release on the grant's own generation, still ours, was taken as gone")
	if r, _ := tr.record(t, tr.spec); r.ReleaseFailures != 1 {
		t.Fatal("the refused release was not counted", r.ReleaseFailures)
	}
	tr.benchID, tr.leased, tr.refuseRelease = strings.Repeat("7", 32), false, 1
	if _, err := tr.c.Cancel(context.Background(), tr.spec); !isRefusal(err, "stale_owner") {
		t.Fatal("a later generation did not prove the old lease released", err)
	}
	if r, active := tr.record(t, tr.spec); !r.terminal() || active || r.Release != "done" || r.BenchID != strings.Repeat("1", 32) {
		t.Fatal("the old record still holds the key", r.Release, r.BenchID, active)
	}
}
