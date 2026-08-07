package gateway

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

// TestSchemeDerivation asserts wsURL maps http→ws and https→wss correctly.
func TestSchemeDerivation(t *testing.T) {
	tests := []struct {
		hub  string
		want string
	}{
		{"https://hub.agentpod.dev", "wss://hub.agentpod.dev/public/nodes/gateway"},
		{"http://localhost:3001", "ws://localhost:3001/public/nodes/gateway"},
	}
	for _, tc := range tests {
		got := wsURL(tc.hub)
		if got != tc.want {
			t.Errorf("wsURL(%q) = %q, want %q", tc.hub, got, tc.want)
		}
	}
}

// TestReconnectRetries verifies that runWithOpts retries on dial failure with
// growing backoff, calls onConnected when the dial succeeds, and exits cleanly
// on context cancel. No real sleeps are performed: a fake sleepFn records the
// durations passed to it.
func TestReconnectRetries(t *testing.T) {
	const failCount = 3

	var (
		slept     []time.Duration
		callCount int
	)
	connected := make(chan struct{}, 1)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	fakeDial := func(dialCtx context.Context, _ config.Config, _ Handler, onConnected func()) error {
		callCount++
		if callCount <= failCount {
			return fmt.Errorf("fake dial failure %d", callCount)
		}
		// Successful connection: notify, reset backoff, block until ctx done.
		onConnected()
		select {
		case connected <- struct{}{}:
		default:
		}
		<-dialCtx.Done()
		return dialCtx.Err()
	}

	fakeSleep := func(sleepCtx context.Context, d time.Duration) bool {
		slept = append(slept, d)
		return sleepCtx.Err() == nil
	}

	done := make(chan error, 1)
	go func() {
		done <- runWithOpts(ctx, config.Config{Hub: "http://localhost:9999"}, stubHandler, runOptions{
			dialFn:   fakeDial,
			sleepFn:  fakeSleep,
			jitterFn: nil, // no jitter → deterministic backoff values
		})
	}()

	// Wait for the successful connection.
	select {
	case <-connected:
	case <-time.After(2 * time.Second):
		t.Fatal("did not connect within timeout")
	}

	// sleepFn must have been called exactly failCount times.
	if len(slept) != failCount {
		t.Fatalf("expected %d sleep calls, got %d (slept=%v)", failCount, len(slept), slept)
	}
	// Backoff must strictly increase with each retry.
	for i := 1; i < len(slept); i++ {
		if slept[i] <= slept[i-1] {
			t.Errorf("backoff not increasing: slept[%d]=%v <= slept[%d]=%v",
				i, slept[i], i-1, slept[i-1])
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not exit after context cancel")
	}
}

// TestReconnectCtxCancel verifies that Run exits promptly when ctx is
// cancelled, even while the fake sleepFn is active.
func TestReconnectCtxCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	sleptCount := 0
	fakeDial := func(_ context.Context, _ config.Config, _ Handler, _ func()) error {
		return fmt.Errorf("always fails")
	}
	fakeSleep := func(sleepCtx context.Context, _ time.Duration) bool {
		sleptCount++
		if sleptCount >= 2 {
			cancel() // cancel during the second sleep
		}
		return sleepCtx.Err() == nil
	}

	err := runWithOpts(ctx, config.Config{}, stubHandler, runOptions{
		dialFn:  fakeDial,
		sleepFn: fakeSleep,
	})

	if err == nil {
		t.Fatal("expected non-nil error on context cancel")
	}
}

// TestReconnectOnConnectedResetsAttempt verifies that a successful connection
// resets the attempt counter so the next reconnect-after-drop starts from the
// base backoff (1 s) rather than continuing the previous doubling sequence.
//
// Sequence:
//
//	call 1 → fail  → sleep 1s (attempt 0)
//	call 2 → ok    → onConnected resets attempt=0 → drop → sleep 1s (attempt 0 again)
//	call 3 → fail  → sleep 2s (attempt 1, NOT 2s as it would be without reset)
//	call 4 → ok    → block until ctx cancel (signals test all 3 sleeps are recorded)
func TestReconnectOnConnectedResetsAttempt(t *testing.T) {
	var slept []time.Duration
	// reachedFinalBlock is closed when call 4 starts blocking, by which point
	// all three preceding sleeps have been recorded — no races.
	reachedFinalBlock := make(chan struct{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	callCount := 0
	fakeDial := func(dialCtx context.Context, _ config.Config, _ Handler, onConnected func()) error {
		callCount++
		switch callCount {
		case 1:
			// First dial: fail → backoff for attempt 0 = 1 s.
			return fmt.Errorf("initial fail")
		case 2:
			// Succeed then immediately drop → onConnected resets attempt to 0.
			onConnected()
			return fmt.Errorf("connection dropped")
		case 3:
			// Fail again after reset → backoff must be 1 s (attempt 0), not 2 s.
			return fmt.Errorf("second fail after reset")
		default:
			// Stable connection: signal test that all three sleeps are done.
			onConnected()
			close(reachedFinalBlock)
			<-dialCtx.Done()
			return dialCtx.Err()
		}
	}

	fakeSleep := func(sleepCtx context.Context, d time.Duration) bool {
		slept = append(slept, d)
		return sleepCtx.Err() == nil
	}

	done := make(chan error, 1)
	go func() {
		done <- runWithOpts(ctx, config.Config{}, stubHandler, runOptions{
			dialFn:   fakeDial,
			sleepFn:  fakeSleep,
			jitterFn: nil,
		})
	}()

	// Wait until we're inside the stable connection (call 4); by then slept has
	// three entries in order.
	select {
	case <-reachedFinalBlock:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for reconnect sequence to complete")
	}

	// slept[0]: attempt 0 after call 1 → 1 s
	// slept[1]: attempt 0 after call 2 drop (reset) → 1 s  ← proves reset
	// slept[2]: attempt 1 after call 3 → 2 s               ← proves growth after reset
	if len(slept) < 3 {
		t.Fatalf("expected 3 sleep calls, got %d (%v)", len(slept), slept)
	}
	if slept[0] != backoffBase {
		t.Errorf("slept[0] (pre-success): expected %v, got %v", backoffBase, slept[0])
	}
	if slept[1] != backoffBase {
		t.Errorf("slept[1] (post-reset): expected %v, got %v; onConnected did not reset attempt",
			backoffBase, slept[1])
	}
	if slept[2] != 2*backoffBase {
		t.Errorf("slept[2]: expected %v (attempt 1 after reset), got %v", 2*backoffBase, slept[2])
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not exit after cancel")
	}
}

// TestReconnectLogsDisconnectReason verifies that each connection loss is
// logged with the underlying error and the computed backoff — operators were
// previously blind to why an agent kept reconnecting.
func TestReconnectLogsDisconnectReason(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	done := make(chan error, 1)
	go func() {
		done <- runWithOpts(ctx, config.Config{}, stubHandler, runOptions{
			dialFn: func(context.Context, config.Config, Handler, func()) error {
				calls++
				if calls >= 2 {
					cancel()
				}
				return errors.New("websocket: close 1006 abnormal closure")
			},
			sleepFn:  func(ctx context.Context, d time.Duration) bool { return ctx.Err() == nil },
			jitterFn: nil,
		})
	}()
	<-done

	out := buf.String()
	if !strings.Contains(out, "close 1006 abnormal closure") {
		t.Fatalf("disconnect reason not logged; log output: %q", out)
	}
	if !strings.Contains(out, "reconnecting in") {
		t.Fatalf("backoff not logged; log output: %q", out)
	}
}
