package benchlaunch

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// recordedCancelledRunReply is what benchd answered the run's own POST once a
// cancellation barrier won its finalization race: the payload stopped
// ("context canceled"), the reply could not be stored (receipt_save_failed,
// "operation cancellation requested"), and the caller got this live 503.
func recordedCancelledRunReply(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/run-cancelled-receipt-save-failed.json")
	if err != nil {
		t.Fatal(err)
	}
	return bytes.TrimSpace(raw)
}

// The staging rehearsal: Hermes running at execute_pending, the board moved
// the card off the stage, the Hub's current decision answered stale_owner.
// The node vetoed its record and sent one cancel; benchd stopped the payload
// and stored no receipt, so the run's lookup answers cancel_requested for
// ever. The bench stayed ready with this holder's lease supervised,
// stop_requested, its execution stopped, and the node answered pending on
// every status (the Hub's run_ended.node:pending, 20 minutes on). It must end:
// stale_owner (the Hub's run_ended.stopped), the stopped lease released with
// its own token, no stop, no second run, and no completion.
func TestRunCancelledBeforeItsReceiptWasStoredEndsAndReleases(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.barrier, tr.stopLag = true, 1
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("a run still in flight was not pending", err)
	}
	// While it runs, a status is pending and touches nothing.
	if _, err := tr.c.Status(context.Background(), tr.spec); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("a running run was not pending", err)
	}
	// The board ended the run: the decision is stale_owner from now on.
	tr.superseded.Store(true)
	tr.barrierReply = recordedCancelledRunReply(t)
	status, err := tr.c.Status(context.Background(), tr.spec)
	if err != nil || status.State != "cancel_requested" {
		t.Fatal("the first retiring pass did not wait for the execution to stop", status.State, err)
	}
	if len(tr.cancels) != 1 || tr.cancels[0].TargetRequestID != tr.spec.RunRequestID {
		t.Fatal("the cancel did not target the run", tr.cancels)
	}
	if tr.count(tr.posts, "release") != 0 || !tr.leased {
		t.Fatal("the lease was released while the execution was still running")
	}
	// The execution is stopped now; the next pass ends the record.
	_, err = tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "stale_owner")
	r, _ := tr.record(t, tr.spec)
	if !r.terminal() || r.Completion != nil || r.Phase != phaseRefused || r.Code != "stale_owner" {
		t.Fatal("the record did not end refused", r.Phase, r.Code, r.Release)
	}
	if tr.count(tr.effects, "release") != 1 || tr.leased {
		t.Fatal("the stopped lease was not released by its holder", tr.count(tr.effects, "release"), tr.leased)
	}
	// Every later read answers the same, and nothing is sent again.
	for i := 0; i < 2; i++ {
		_, err = tr.c.Status(context.Background(), tr.spec)
		wantCode(t, err, "stale_owner")
	}
	_, err = tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "stale_owner")
	if tr.count(tr.posts, "run") != 1 || tr.count(tr.posts, "stop") != 0 || tr.count(tr.posts, "cancel") != 1 || tr.count(tr.effects, "release") != 1 {
		t.Fatal("the run, a stop, a cancel or a release was sent again", tr.count(tr.posts, "run"), tr.count(tr.posts, "stop"), tr.count(tr.posts, "cancel"), tr.count(tr.effects, "release"))
	}
}

// A run cancelled by someone else (an operator's cancel) while the Hub still
// holds the attempt current ends the same way, but as a failed run: it did not
// finish, so verification_failed, never a pass.
func TestRunCancelledElsewhereEndsFailedAndReleases(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.barrier = true
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal(err)
	}
	tr.barrierCancelled = true
	_, err := tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "verification_failed")
	if tr.count(tr.effects, "release") != 1 || tr.leased || tr.count(tr.posts, "cancel") != 0 || tr.count(tr.posts, "run") != 1 {
		t.Fatal("an externally cancelled run did not end and release", tr.count(tr.effects, "release"), tr.leased)
	}
}

// A barrier while the bench cannot be read proves nothing about the
// execution: parked, nothing released.
func TestCancelledRunWithAnUnreadableBenchParks(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.barrier = true
	_, _ = tr.c.Execute(context.Background(), tr.spec, admitAll)
	tr.barrierCancelled, tr.statusDown = true, true
	if _, err := tr.c.Status(context.Background(), tr.spec); !errors.Is(err, benchdispatch.ErrPending) || isRefusal(err, "verification_failed") {
		t.Fatal("an unreadable bench ended the attempt", err)
	}
	if tr.count(tr.posts, "release") != 0 || !tr.leased {
		t.Fatal("a lease was released without seeing the execution stopped")
	}
}

// A run whose checkpoint SuperBench refused (the harness left files outside
// the repository) ends verification_failed with SuperBench's own words, so
// the card says why instead of guessing at a crash or a restart.
func TestRefusedCheckpointCarriesTheBenchsOwnMessage(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.exit, tr.refusalMessage = 1, "bench has uncommitted or untracked files; commit or preserve them before checkpoint/release\n\x00"
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "verification_failed")
	want := "bench has uncommitted or untracked files; commit or preserve them before checkpoint/release"
	if got := RefusalMessage(err); got != want {
		t.Fatalf("the refusal said %q", got)
	}
	if _, err = tr.c.Status(context.Background(), tr.spec); RefusalMessage(err) != want {
		t.Fatal("a later status lost the bench's message", err)
	}
}

func TestProducerMessageIsBoundedAndPrintable(t *testing.T) {
	long := strings.Repeat("é", 200) // 400 bytes
	got := producerMessage(&benchworkspace.APIError{Message: "  a\tb\x00c " + long})
	if len(got) > maxProducerMessage || !utf8.ValidString(got) || strings.ContainsAny(got, "\t\x00") || !strings.HasPrefix(got, "a b c é") {
		t.Fatalf("unsafe message %q (%d bytes)", got, len(got))
	}
	if producerMessage(nil) != "" {
		t.Fatal("a missing error made a message")
	}
}

// A release SuperBench keeps refusing (the tree is dirty) used to be retried a
// few times and then go quiet, with the lease held. The record now says so on
// every reply: the refusal and later statuses carry lease held and the
// bench's words, so the hub can name the operator's path.
func TestARefusedReleaseIsReportedAsAHeldLease(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	const dirty = "bench has uncommitted or untracked files; commit or preserve them before checkpoint/release"
	tr.exit, tr.refusalMessage = 1, dirty
	tr.refuseRelease, tr.releaseMessage = 100, dirty
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "verification_failed")
	if !RefusalLeaseHeld(err) || RefusalMessage(err) != dirty || !tr.leased {
		t.Fatal("a refused release was not reported as a held lease", RefusalLeaseHeld(err), RefusalMessage(err), tr.leased)
	}
	for i := 0; i < 3; i++ {
		_, err = tr.c.Status(context.Background(), tr.spec)
		wantCode(t, err, "verification_failed")
		if !RefusalLeaseHeld(err) {
			t.Fatal("a later status forgot the held lease", i)
		}
	}
	if tr.count(tr.posts, "release") < 4 || tr.count(tr.effects, "release") != 0 {
		t.Fatal("the release was not retried on each status", tr.count(tr.posts, "release"))
	}
	// Once an operator frees the tree, the next status releases and the record ends clean.
	tr.refuseRelease = 0
	_, err = tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "verification_failed")
	if RefusalLeaseHeld(err) || tr.leased {
		t.Fatal("a released lease was still reported held")
	}
}

// A vetoed record whose release is refused parks naming the held lease.
func TestARetiredRecordWithARefusedReleaseParksAsHeld(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.refuseRelease, tr.releaseMessage = 100, "bench has uncommitted or untracked files"
	status, err := tr.c.Cancel(context.Background(), tr.spec)
	if err != nil || !status.LeaseHeld || status.Message != "bench has uncommitted or untracked files" {
		t.Fatal("a retired record with a refused release did not report its held lease", status, err)
	}
}

// The card's next attempt waits on the held bench and says why: pending with
// the held lease, never a new lease or run, until an operator frees it.
func TestANewerAttemptWaitingOnAHeldLeaseSaysSo(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.exit, tr.refuseRelease, tr.releaseMessage = 1, 100, "bench has uncommitted or untracked files"
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "verification_failed")
	next := nextAttempt(tr.spec)
	tr.current.Store(&next)
	_, err = tr.c.Prepare(context.Background(), next, tr.task)
	message, held := HeldLeaseOf(err)
	if !held || message != "bench has uncommitted or untracked files" || !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("the newer attempt did not wait naming the held lease", err)
	}
	if tr.count(tr.effects, "lease") != 1 || tr.count(tr.posts, "run") != 1 {
		t.Fatal("the newer attempt reached the held bench")
	}
}
