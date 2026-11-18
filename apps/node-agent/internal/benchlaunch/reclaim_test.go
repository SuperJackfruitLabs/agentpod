package benchlaunch

import (
	"context"
	"errors"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
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
