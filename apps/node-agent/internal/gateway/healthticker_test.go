package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

// shortIntervals shrinks both connection tickers for the duration of a test.
func shortIntervals(t *testing.T, d time.Duration) {
	t.Helper()
	origHealth, origHB := healthTickInterval, heartbeatInterval
	healthTickInterval, heartbeatInterval = d, d
	t.Cleanup(func() { healthTickInterval, heartbeatInterval = origHealth, origHB })
}

// droppingServer accepts one websocket, drains frames for hold, then drops the
// connection — the shape of a flapping hub link.
func droppingServer(hold time.Duration) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		readCtx, done := context.WithTimeout(r.Context(), hold)
		defer done()
		for {
			if _, _, err := c.Read(readCtx); err != nil {
				return // hold elapsed (or client gone) — drop the connection
			}
		}
	}))
}

// TestHealthTickerStopsWhenConnectionEnds asserts that the health ticker a
// connection starts is gone once that connection ends.
//
// REGRESSION: the ticker goroutine was started on the caller's context, which
// is the process-lifetime context owned by runWithOpts, so its only exit path
// was node shutdown. Every reconnect therefore left another ticker running
// against a dead socket, and each one kept calling gatherHealth — a full
// station sweep — every healthTickInterval, forever. On a flapping link the
// sweeps accumulated linearly with the reconnect count (a real node reached
// ~11 concurrent sweeps after 228 reconnects, spawning ~290 processes/second).
func TestHealthTickerStopsWhenConnectionEnds(t *testing.T) {
	const tick = 10 * time.Millisecond
	shortIntervals(t, tick)

	var calls atomic.Int64
	gather := func() []HealthReport {
		calls.Add(1)
		return []HealthReport{{Key: "hermes:coder-kai", OK: true}}
	}

	srv := droppingServer(20 * tick)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := config.Config{Hub: srv.URL, NodeID: "n", NodeSecret: "s"}

	// Drive the same sequence runWithOpts does: connect, get dropped, repeat.
	const reconnects = 5
	for i := 0; i < reconnects; i++ {
		_ = connectOnce(ctx, cfg, stubHandler, func() {}, "dev", gather)
	}

	if calls.Load() == 0 {
		t.Fatal("gatherHealth was never called; the test never exercised a live ticker")
	}

	// Every connection above is closed and connectOnce has returned for each.
	// Let any tick already in flight land, then assert the count is frozen:
	// no ticker may outlive its connection.
	time.Sleep(5 * tick)
	settled := calls.Load()
	time.Sleep(20 * tick)

	if got := calls.Load(); got != settled {
		t.Fatalf("health ticker outlived its connection: gatherHealth calls went %d -> %d "+
			"over 20 tick intervals after all %d connections closed; leaked tickers keep "+
			"sweeping stations forever", settled, got, reconnects)
	}
}

// TestReadLoopDeathEndsConnection asserts that connectOnce returns promptly
// when the inbound read loop dies, rather than waiting for the next heartbeat
// write to fail. A dropped socket should not leave a connection nominally
// alive for up to a full heartbeatInterval.
func TestReadLoopDeathEndsConnection(t *testing.T) {
	const tick = 10 * time.Millisecond
	// Health ticks stay fast; the heartbeat is deliberately slow so that the
	// only way connectOnce can return quickly is the read loop reporting the
	// drop.
	origHealth, origHB := healthTickInterval, heartbeatInterval
	healthTickInterval, heartbeatInterval = tick, 10*time.Second
	t.Cleanup(func() { healthTickInterval, heartbeatInterval = origHealth, origHB })

	srv := droppingServer(5 * tick)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := config.Config{Hub: srv.URL, NodeID: "n", NodeSecret: "s"}

	done := make(chan struct{})
	go func() {
		_ = connectOnce(ctx, cfg, stubHandler, func() {}, "dev", nil)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("connectOnce did not return after the read loop died; it is waiting " +
			"for the heartbeat to notice the connection is gone")
	}
}
