package benchlaunch

import (
	"context"
	"errors"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

// A record whose profile the node no longer serves is retired only before its run was sent: the
// lease is released with the record's own token, nothing runs, and the next attempt can take the bench.
func TestRetireUnlaunchedReleasesAPreparedRecordAndNeverRuns(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.superseded.Store(true)
	_, err := tr.c.RetireUnlaunched(context.Background(), tr.spec)
	wantCode(t, err, "stale_owner")
	tr.assertRetired(t)
}

// Once the run was sent, even with its reply lost, retiring here could not prove nothing ran.
func TestRetireUnlaunchedLeavesASentRunAlone(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.loseAfter["run"] = true
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal(err)
	}
	cancels := len(tr.cancels)
	if _, err := tr.c.RetireUnlaunched(context.Background(), tr.spec); !errors.Is(err, ErrLaunched) {
		t.Fatal("a sent run was retired", err)
	}
	r, active := tr.record(t, tr.spec)
	if r.Cancelled || r.terminal() || !active || len(tr.cancels) != cancels || tr.count(tr.effects, "release") != 0 {
		t.Fatal("a sent run's record was changed", r.Cancelled, r.Phase, len(tr.cancels))
	}
}

// The veto is journaled before anything is released, so no execute can send the run afterwards.
func TestRetireUnlaunchedVetoesTheRun(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.refuseRelease = 1
	_, _ = tr.c.RetireUnlaunched(context.Background(), tr.spec)
	tr.superseded.Store(false)
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "stale_owner")
	if tr.count(tr.posts, "run") != 0 {
		t.Fatal("a vetoed record launched")
	}
}

// The live strand: the reservation was journaled, then the launch's own hub current check (the
// same slow decision) failed before create, so SuperBench got no call. The identical prepare,
// re-sent, resumes the same record: every step goes out once, never twice.
func TestPrepareResumesAReservationThatSentNothing(t *testing.T) {
	tr := newTrial(t)
	calls := 0
	c := tr.c
	c.Current = func(context.Context, benchdispatch.SourceSpec) error {
		calls++
		if calls == 2 { // the check under the journal lock, before create leaves
			return errors.New("hub decision timed out")
		}
		return nil
	}
	if _, err := c.Prepare(context.Background(), tr.spec, tr.task); err == nil {
		t.Fatal("the failed check did not stop the prepare")
	}
	r, active := tr.record(t, tr.spec)
	if r.Phase != phaseReserved || !active || len(r.Steps) != 0 || tr.count(tr.posts, "lease") != 0 {
		t.Fatal("fixture: not a reservation that sent nothing", r.Phase, len(r.Steps))
	}
	// Status alone never sends: it is still pending.
	if s, err := c.Status(context.Background(), tr.spec); err != nil || s.State != "pending" {
		t.Fatal("status of the reservation", s.State, err)
	}
	if _, err := c.Prepare(context.Background(), tr.spec, tr.task); err != nil {
		t.Fatal("the resumed prepare did not finish", err)
	}
	if _, err := c.Prepare(context.Background(), tr.spec, tr.task); err != nil {
		t.Fatal("a third identical prepare was refused", err)
	}
	for _, op := range []string{"lease", "checkpoint", "observe"} {
		if got := tr.count(tr.posts, op); got != 1 {
			t.Fatalf("%s went out %d times", op, got)
		}
	}
	if tr.count(tr.posts, "run") != 0 {
		t.Fatal("a prepare launched")
	}
}
