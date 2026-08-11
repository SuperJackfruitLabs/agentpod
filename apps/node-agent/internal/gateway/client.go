package gateway

import (
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/host"
)

const (
	// backoffBase is the starting backoff duration (attempt 0).
	backoffBase = time.Second
	// backoffCap is the maximum backoff duration.
	backoffCap = 30 * time.Second
)

// healthTickInterval is the cadence at which the agent pushes station health
// frames to the hub. Exported as a package-level var so tests can override it
// without touching production code paths.
var healthTickInterval = 30 * time.Second

// HealthReport is a single station's health snapshot inside a health push frame.
// Metrics fields are nullable (pointer) so they can be omitted as JSON null when
// not available. OK=false signals that Health(key) returned an error; in that
// case all metric fields are nil.
type HealthReport struct {
	Key       string   `json:"key"`
	OK        bool     `json:"ok"`
	Running   bool     `json:"running"`
	PID       *int     `json:"pid"`
	CPUPct    *float64 `json:"cpuPct"`
	MemBytes  *int64   `json:"memBytes"`
	UptimeSec *int64   `json:"uptimeSec"`
}

// wsURL derives the WebSocket gateway URL from the hub's HTTP(S) URL.
// https://host → wss://host/public/nodes/gateway
// http://host  → ws://host/public/nodes/gateway
func wsURL(hub string) string {
	u := strings.Replace(strings.Replace(hub, "http://", "ws://", 1), "https://", "wss://", 1)
	return u + "/public/nodes/gateway"
}

// calcBackoff returns min(backoffCap, backoffBase * 2^attempt) for attempt ≥ 0.
func calcBackoff(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	b := backoffBase << uint(attempt)
	if b > backoffCap || b <= 0 { // overflow guard
		return backoffCap
	}
	return b
}

// defaultJitter returns a random duration in [0, base/2) to spread reconnects.
func defaultJitter(base time.Duration) time.Duration {
	if base <= 0 {
		return 0
	}
	return time.Duration(rand.Int63n(int64(base)/2 + 1))
}

// defaultSleep waits for d or until ctx is cancelled.
// Returns false if ctx was cancelled (caller should stop the retry loop).
func defaultSleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	select {
	case <-ctx.Done():
		t.Stop()
		return false
	case <-t.C:
		return true
	}
}

// runOptions configures the internal reconnect loop.
// Every field has a production default supplied by Run; tests inject fakes to
// avoid real network dials and real sleeps.
type runOptions struct {
	// dialFn connects and serves one gateway session. On success it calls
	// onConnected (to reset the attempt counter) then blocks until the
	// connection is lost or ctx is cancelled. Returns non-nil on error.
	dialFn func(ctx context.Context, cfg config.Config, h Handler, onConnected func()) error

	// sleepFn waits for d before the next dial attempt. It receives ctx so it
	// can return early on cancellation. Returns false if ctx was cancelled.
	sleepFn func(ctx context.Context, d time.Duration) bool

	// jitterFn returns extra duration to add to the computed backoff.
	// nil means no jitter (used in tests for deterministic assertions).
	jitterFn func(base time.Duration) time.Duration
}

// runWithOpts is the testable core of the reconnect loop.
//
// It calls opts.dialFn in a loop; on any error it computes the exponential
// backoff (min(cap, base*2^attempt) + optional jitter), waits via opts.sleepFn,
// and retries. When dialFn calls onConnected the attempt counter is reset to
// 0 so a freshly recovered connection does not inherit a stale penalty.
// The loop exits only when ctx is cancelled.
func runWithOpts(ctx context.Context, cfg config.Config, h Handler, opts runOptions) error {
	attempt := 0
	for ctx.Err() == nil {
		err := opts.dialFn(ctx, cfg, h, func() { attempt = 0 })
		if err != nil && ctx.Err() == nil {
			d := calcBackoff(attempt)
			if opts.jitterFn != nil {
				d += opts.jitterFn(d)
			}
			// Operators need the disconnect reason — a silent reconnect loop
			// makes flapping connections undiagnosable.
			log.Printf("gateway: connection lost: %v (reconnecting in %s)", err, d.Round(time.Millisecond))
			attempt++
			if !opts.sleepFn(ctx, d) {
				break
			}
		}
	}
	return ctx.Err()
}

// Run connects to the hub gateway and dispatches inbound requests to h.
// It derives wss:// from an https:// hub URL automatically (Go's default TLS
// stack uses system root CAs — no extra config needed).
// On any disconnect or dial error it reconnects with exponential back-off +
// jitter (min(30 s, 1 s × 2^n) + [0, base/2)), resetting the counter on each
// successful connection. It exits only when ctx is cancelled.
// version is included in the hello frame sent on each connection; use "dev"
// when not built with ldflags.
// gatherHealth is called on each health tick to collect per-station snapshots;
// if nil no health frames are pushed (old-node compat / tests that don't care).
func Run(ctx context.Context, cfg config.Config, h Handler, version string, gatherHealth func() []HealthReport) error {
	return runWithOpts(ctx, cfg, h, runOptions{
		dialFn: func(ctx context.Context, cfg config.Config, h Handler, onConnected func()) error {
			return connectOnce(ctx, cfg, h, onConnected, version, gatherHealth)
		},
		sleepFn:  defaultSleep,
		jitterFn: defaultJitter,
	})
}

// HelloMsg is the frame sent immediately on every connection.
//
// A struct rather than an inline map so contractfix can prove it still
// round-trips the contract's shape. It was a map[string]any until 2026-08-11,
// which is exactly the gap TestHealthFrameStationsRoundTrip warns about: an
// untyped map drifts from the contract and no test notices.
type HelloMsg struct {
	Type         string        `json:"type"`
	HostInfo     host.HostInfo `json:"hostInfo"`
	Version      string        `json:"version,omitempty"`
	Capabilities []string      `json:"capabilities,omitempty"`
}

// connectOnce dials the hub, sends the hello frame, starts the heartbeat
// ticker, and serves the inbound read loop until the connection is lost or ctx
// is cancelled. onConnected is called immediately after the hello is sent so
// the caller can reset the backoff counter. version is embedded in the hello
// frame as the "version" field so the hub can record the agent's build version.
// gatherHealth, if non-nil, is called on each health tick (healthTickInterval)
// and the result is pushed as a {"type":"health","stations":[...]} frame. The
// health ticker runs in its own goroutine, independent of the heartbeat path.
func connectOnce(ctx context.Context, cfg config.Config, h Handler, onConnected func(), version string, gatherHealth func() []HealthReport) error {
	c, _, err := websocket.Dial(ctx, wsURL(cfg.Hub), &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer " + cfg.NodeID + ":" + cfg.NodeSecret}},
	})
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	hello, _ := json.Marshal(HelloMsg{
		Type:         "hello",
		HostInfo:     host.Info(),
		Version:      version,
		Capabilities: NodeCapabilities,
	})
	if err := c.Write(ctx, websocket.MessageText, hello); err != nil {
		return err
	}

	// Connection is fully established — reset the reconnect backoff.
	onConnected()

	// writeMu serializes all WS writes: both the heartbeat ticker below and
	// any response/stream frames written by serve's dispatch goroutines.
	var writeMu sync.Mutex

	// Start the inbound read-loop; shares writeMu with the heartbeat below.
	go serve(ctx, c, h, &writeMu)

	// Health ticker — runs in its own goroutine, entirely separate from the
	// heartbeat path, so a slow gatherHealth call never delays heartbeats.
	if gatherHealth != nil {
		go func() {
			ht := time.NewTicker(healthTickInterval)
			defer ht.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ht.C:
					frame, _ := json.Marshal(map[string]any{
						"type":     "health",
						"stations": gatherHealth(),
					})
					writeMu.Lock()
					_ = c.Write(ctx, websocket.MessageText, frame)
					writeMu.Unlock()
				}
			}
		}()
	}

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			hb, _ := json.Marshal(map[string]any{"type": "heartbeat", "ts": time.Now().UnixMilli()})
			writeMu.Lock()
			err := c.Write(ctx, websocket.MessageText, hb)
			writeMu.Unlock()
			if err != nil {
				return err
			}
		}
	}
}
