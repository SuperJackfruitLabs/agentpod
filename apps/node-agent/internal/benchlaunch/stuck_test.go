package benchlaunch

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

// creating is an attempt the bridge chose to create the key with its own
// request ID: the key had no bench, or its bench was stuck before ready.
func creating(spec benchdispatch.SourceSpec, attempt string) benchdispatch.SourceSpec {
	next := spec
	next.Identity.AttemptID = attempt
	next.Holder, next.LeaseRequestID, next.RunRequestID = "cp_"+attempt, "lease_"+attempt, "run_"+attempt
	next.Create, next.CreateRequestID = true, "create_"+attempt
	return next
}

// failedCreate runs a first attempt whose create fails during initialization:
// SuperBench keeps the bench initializing and returns the owner's grant, which
// the attempt's journal keeps. It returns the next attempt, now current.
func failedCreate(t *testing.T, tr *trial) benchdispatch.SourceSpec {
	t.Helper()
	first := creating(tr.spec, "attempt-1")
	tr.spec = first
	tr.current.Store(&first)
	tr.failCreate = true
	if _, err := tr.c.Prepare(context.Background(), first, tr.task); !isRefusal(err, "verification_failed") {
		t.Fatal("fixture: the first create should fail", err)
	}
	if tr.stuck != "initializing" || tr.stopped {
		t.Fatal("fixture: the bench should be stuck initializing")
	}
	next := creating(tr.spec, "attempt-2")
	tr.current.Store(&next)
	return next
}

func (tr *trial) creates(requestID string) int {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	if _, ok := tr.receipts[requestID]; ok {
		return 1
	}
	return 0
}

// A stuck initializing bench whose owner is our own earlier attempt: the next
// attempt stops that owner with the journaled token, then creates the key's
// next generation once and runs on it.
func TestStuckBenchWeOwnIsStoppedAndCreatedAgain(t *testing.T) {
	tr := newTrial(t)
	next := failedCreate(t, tr)
	old := tr.benchID
	p, err := tr.c.Prepare(context.Background(), next, tr.task)
	if err != nil {
		t.Fatal("the stuck bench was not recovered", err)
	}
	if tr.count(tr.posts, "stop") != 1 || tr.count(tr.effects, "stop") != 1 || tr.count(tr.effects, "create") != 2 || tr.creates("create_attempt-2") != 1 {
		t.Fatal("not one stop then one create", tr.count(tr.posts, "stop"), tr.count(tr.effects, "create"))
	}
	r, _ := tr.record(t, next)
	if r.Stuck != old || r.BenchID == old || r.BenchID != tr.benchID || p.Binding.BenchID != tr.benchID || r.Parked != "" {
		t.Fatal("the new generation was not bound", r.Stuck, r.BenchID, p.Binding.BenchID)
	}
	if _, err := tr.c.Execute(context.Background(), next, admitAll); err != nil {
		t.Fatal("the new generation did not run", err)
	}
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); err != nil || tr.count(tr.posts, "stop") != 1 || tr.count(tr.posts, "create") != 2 {
		t.Fatal("a retry stopped or created again", err)
	}
}

// A stuck bench whose initialization owner is not ours is never stopped, by
// stop or stop_admin. The attempt parks visibly and creates nothing. Once an
// operator stops the owner, a later attempt creates the next generation.
func TestStuckBenchNotOursParks(t *testing.T) {
	tr := newTrial(t)
	tr.stuck, tr.initToken = "initializing", strings.Repeat("7", 32)
	next := creating(tr.spec, "attempt-2")
	tr.current.Store(&next)
	for i := 0; i < 2; i++ {
		if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, ErrBenchStuck) || !errors.Is(err, benchdispatch.ErrPending) {
			t.Fatal("a stuck bench that is not ours did not park", err)
		}
	}
	if tr.count(tr.posts, "stop") != 0 || tr.count(tr.posts, "stop_admin") != 0 || tr.count(tr.posts, "create") != 0 || tr.count(tr.posts, "lease") != 0 {
		t.Fatal("a stuck bench that is not ours was acted on")
	}
	if st, err := tr.c.Status(context.Background(), next); err != nil || st.State != parkStuck {
		t.Fatal("the park is not visible", st.State, err)
	}
	tr.stopped = true // an operator's stop_admin
	later := creating(tr.spec, "attempt-3")
	tr.current.Store(&later)
	if _, err := tr.c.Prepare(context.Background(), later, tr.task); err != nil {
		t.Fatal("a stopped owner did not let the create go", err)
	}
	if tr.count(tr.posts, "stop") != 0 || tr.count(tr.effects, "create") != 1 {
		t.Fatal("not one create after the operator's stop")
	}
}

// The owner is stopped but the host has not freed the stuck tree: the create
// is a conflict. The attempt parks with its own reason, never resends the
// create and never stops again, however often it is asked.
func TestRefusedCreateOnAStuckBenchParks(t *testing.T) {
	tr := newTrial(t)
	next := failedCreate(t, tr)
	tr.holdRecreate = true
	for i := 0; i < 3; i++ {
		if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, ErrRecreateRefused) {
			t.Fatal("a refused create did not park", err)
		}
		if st, err := tr.c.Status(context.Background(), next); err != nil || st.State != parkRefused {
			t.Fatal("the park is not visible", st.State, err)
		}
	}
	if tr.count(tr.posts, "create") != 2 || tr.count(tr.posts, "stop") != 1 || tr.count(tr.posts, "lease") != 0 {
		t.Fatal("a refused create was retried", tr.count(tr.posts, "create"), tr.count(tr.posts, "stop"))
	}
	r, active := tr.record(t, next)
	if r.terminal() || !active || r.Parked != parkRefused {
		t.Fatal("a refused create was not parked", r.Phase, r.Parked)
	}
	// The hub moves on: the parked attempt retires and frees the key.
	later := creating(tr.spec, "attempt-3")
	tr.current.Store(&later)
	tr.holdRecreate = false
	if _, err := tr.c.Prepare(context.Background(), later, tr.task); err != nil {
		t.Fatal("a later attempt did not recover the bench", err)
	}
	if old, _ := tr.record(t, next); !old.terminal() || tr.count(tr.posts, "stop") != 1 {
		t.Fatal("the parked attempt was not retired, or the owner was stopped again")
	}
}

// A lost stop reply: the stop acted. The retry reads status, sees the owner
// stopped and creates, without a second stop.
func TestLostStopReplyIsRecoveredWithoutASecondStop(t *testing.T) {
	tr := newTrial(t)
	next := failedCreate(t, tr)
	tr.loseAfter["stop"] = true
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("a lost stop reply did not park", err)
	}
	restarted := tr.coordinator(tr.c.Repositories)
	if _, err := restarted.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("a lost stop reply was not recovered", err)
	}
	if tr.count(tr.posts, "stop") != 1 || tr.creates("create_attempt-2") != 1 {
		t.Fatal("the stop was sent again", tr.count(tr.posts, "stop"))
	}
}

// A stop that never reached the producer leaves the owner running. The attempt
// stays pending and does not send a second stop; it never creates over a
// running owner.
func TestUnansweredStopIsNotResent(t *testing.T) {
	tr := newTrial(t)
	next := failedCreate(t, tr)
	tr.loseBefore["stop"] = true
	for i := 0; i < 3; i++ {
		if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
			t.Fatal("an unanswered stop did not park", err)
		}
	}
	if tr.count(tr.posts, "stop") != 1 || tr.count(tr.posts, "create") != 1 {
		t.Fatal("an unanswered stop was resent or a create went out", tr.count(tr.posts, "stop"), tr.count(tr.posts, "create"))
	}
}

// A lost create reply on the stuck bench is recovered from its receipt: the
// next generation is created once.
func TestLostCreateReplyOnAStuckBenchIsRecoveredByReceipt(t *testing.T) {
	tr := newTrial(t)
	next := failedCreate(t, tr)
	tr.loseAfter["create"] = true
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("a lost create reply did not park", err)
	}
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("a lost create reply was not recovered", err)
	}
	if tr.count(tr.posts, "create") != 2 || tr.count(tr.effects, "create") != 2 || tr.count(tr.posts, "stop") != 1 {
		t.Fatal("the create or stop was sent again", tr.count(tr.posts, "create"), tr.count(tr.posts, "stop"))
	}
}

// The earlier attempt's failed create reply was lost, so its journal has no
// grant. The token is read from that create's receipt.
func TestOwnerTokenIsReadFromALostCreateReceipt(t *testing.T) {
	tr := newTrial(t)
	first := creating(tr.spec, "attempt-1")
	tr.current.Store(&first)
	tr.failCreate, tr.loseAfter["create"] = true, true
	if _, err := tr.c.Prepare(context.Background(), first, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("fixture: the first create's reply should be lost", err)
	}
	next := creating(tr.spec, "attempt-2")
	tr.current.Store(&next)
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("the owner's token was not recovered from the receipt", err)
	}
	if tr.count(tr.effects, "stop") != 1 || tr.creates("create_attempt-2") != 1 {
		t.Fatal("not one stop then one create")
	}
}

// A create over a stuck bench must make a new generation. One that reports
// the stuck bench_id is not the next generation and is never bound.
func TestRecreateOnTheStuckGenerationIsRefused(t *testing.T) {
	tr := newTrial(t)
	next := failedCreate(t, tr)
	tr.sameRecreate = true
	_, err := tr.c.Prepare(context.Background(), next, tr.task)
	wantCode(t, err, "verification_failed")
	if tr.count(tr.posts, "lease") != 0 {
		t.Fatal("a create on the stuck generation was leased")
	}
}

// A grant kept from an earlier generation is not the stuck generation's owner:
// it is never used to stop it.
func TestOwnerTokenFromAnotherGenerationIsNotUsed(t *testing.T) {
	tr := newTrial(t)
	next := failedCreate(t, tr)
	// Out of band, that bench was freed and another create stuck on a new
	// generation under an owner this node never held.
	tr.benchID, tr.initToken = strings.Repeat("8", 32), strings.Repeat("9", 32)
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, ErrBenchStuck) {
		t.Fatal("another generation's owner was taken as ours", err)
	}
	if tr.count(tr.posts, "stop") != 0 || tr.count(tr.posts, "create") != 1 {
		t.Fatal("another generation's owner was stopped or created over")
	}
}

// A stop the producer refuses (our token is no longer the owner's) parks the
// attempt: no create goes out over an owner that was not stopped, and the
// refusal is replayed from the journal, never resent.
func TestRefusedStopParks(t *testing.T) {
	tr := newTrial(t)
	next := failedCreate(t, tr)
	tr.initToken = strings.Repeat("9", 32)
	for i := 0; i < 2; i++ {
		if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, ErrBenchStuck) {
			t.Fatal("a refused stop did not park", err)
		}
	}
	if tr.count(tr.posts, "stop") != 1 || tr.count(tr.posts, "create") != 1 {
		t.Fatal("a refused stop was resent or created over", tr.count(tr.posts, "stop"), tr.count(tr.posts, "create"))
	}
}
