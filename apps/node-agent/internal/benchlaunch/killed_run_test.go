package benchlaunch

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

// recordedKilledRun is the run reply benchd stored as the final receipt when
// `systemctl restart superbench` killed the payload (KillMode=control-group):
// 503 unavailable, "command failed; stopped lease retained: signal: killed" in
// its log, the lease still held by this holder, stopped, with stop_requested.
func recordedKilledRun(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/run-killed-by-restart.json")
	if err != nil {
		t.Fatal(err)
	}
	return bytes.TrimSpace(raw)
}

// The staging incident: the run was sent, its reply never came back, and the
// only answer is the completed receipt holding that stored 503. It is final: the
// attempt ends failed (never a pass), its own stopped lease is released with its
// token, and nothing is sent again.
func TestRunKilledByARestartEndsFailedAndReleasesItsLease(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.killed = recordedKilledRun(t)
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("a lost run reply was not pending", err)
	}
	restarted := tr.coordinator(tr.c.Repositories)
	for i := 0; i < 2; i++ {
		status, err := restarted.Status(context.Background(), tr.spec)
		wantCode(t, err, "verification_failed")
		if status.Completion != nil {
			t.Fatal("a killed run was reported as a completion")
		}
	}
	if tr.count(tr.effects, "release") != 1 || tr.leased {
		t.Fatal("the stopped lease was not released by its holder", tr.count(tr.effects, "release"), tr.leased)
	}
	if tr.count(tr.posts, "run") != 1 || tr.count(tr.posts, "stop") != 0 {
		t.Fatal("the run was resent, or a stop was sent for an execution already stopped")
	}
	if _, err := restarted.Execute(context.Background(), tr.spec, admitAll); !isRefusal(err, "verification_failed") {
		t.Fatal("execute after the ruling did not answer the same refusal", err)
	}
}

// The same reply delivered live says nothing final by itself: it parks until
// the receipt is read, and the receipt then ends the attempt.
func TestLiveUnavailableRunReplyParksUntilItsReceiptIsRead(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.killed, tr.killedLive = recordedKilledRun(t), true
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("a live unavailable reply was treated as final", err)
	}
	if tr.count(tr.effects, "release") != 0 || tr.count(tr.posts, "lookup") != 0 {
		t.Fatal("a live unavailable reply was acted on before its receipt was read")
	}
	_, err := tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "verification_failed")
	if tr.count(tr.effects, "release") != 1 || tr.leased || tr.count(tr.posts, "run") != 1 {
		t.Fatal("the receipt did not end the attempt and release its lease")
	}
}

// A stored operation_in_doubt is the producer's own word that the effects need
// reconciliation: it parks, it does not end the attempt.
func TestStoredOperationInDoubtStillParks(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.killed = []byte(`{"version":"superbench.v2","operation":"run","request_id":"run_x","ok":false,"error":{"code":"operation_in_doubt","message":"response requires local reconciliation"}}`)
	_, _ = tr.c.Execute(context.Background(), tr.spec, admitAll)
	if _, err := tr.c.Status(context.Background(), tr.spec); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("a stored operation_in_doubt did not park", err)
	}
	if tr.count(tr.effects, "release") != 0 {
		t.Fatal("an in-doubt run released its lease")
	}
}
