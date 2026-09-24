package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

// stubHandler is a no-op handler used by tests that only care about hello/heartbeat.
var stubHandler Handler = HandlerFunc(func(_ context.Context, _ string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
	return nil, false, fmt.Errorf("no handler yet")
})

func TestRunSendsHello(t *testing.T) {
	got := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer node_1:") {
			t.Error("missing auth")
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		_, data, err := c.Read(context.Background())
		if err != nil {
			return
		}
		got <- string(data)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg := config.Config{Hub: srv.URL, NodeID: "node_1", NodeSecret: "s"}
	go Run(ctx, cfg, stubHandler, "dev", nil)

	select {
	case msg := <-got:
		if !strings.Contains(msg, `"type":"hello"`) {
			t.Fatalf("first msg = %s", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no hello received")
	}
}

// TestHealthFrameIsPushed verifies that connectOnce sends a {"type":"health",...}
// frame to the hub within a short time after connection.  It uses a stub
// gatherHealth that returns one HealthReport and a very short tick interval
// (overriding the package-level healthTickInterval) so the test finishes fast.
func TestHealthFrameIsPushed(t *testing.T) {
	// Override tick interval for the test so we don't wait 30 s.
	orig := healthTickInterval
	healthTickInterval = 50 * time.Millisecond
	defer func() { healthTickInterval = orig }()

	pid := 42
	cpu := 1.5
	mem := int64(12345678)
	up := int64(300)
	stubGather := func() []HealthReport {
		return []HealthReport{{
			Key:       "hermes:coder-kai",
			OK:        true,
			Running:   true,
			PID:       &pid,
			CPUPct:    &cpu,
			MemBytes:  &mem,
			UptimeSec: &up,
		}}
	}

	frames := make(chan string, 20)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				return
			}
			frames <- string(data)
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg := config.Config{Hub: srv.URL, NodeID: "node_1", NodeSecret: "s"}
	go Run(ctx, cfg, stubHandler, "dev", stubGather)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case msg := <-frames:
			var frame map[string]any
			if err := json.Unmarshal([]byte(msg), &frame); err != nil {
				continue
			}
			if frame["type"] != "health" {
				continue // skip hello / heartbeat
			}
			stations, ok := frame["stations"].([]any)
			if !ok || len(stations) == 0 {
				t.Fatalf("health frame missing stations: %s", msg)
			}
			s, ok := stations[0].(map[string]any)
			if !ok {
				t.Fatalf("station[0] not an object: %s", msg)
			}
			if s["key"] != "hermes:coder-kai" {
				t.Fatalf("station key = %v, want hermes:coder-kai", s["key"])
			}
			if s["ok"] != true {
				t.Fatalf("station ok = %v, want true", s["ok"])
			}
			return // GREEN
		case <-deadline:
			t.Fatal("no health frame received within 2 s")
		}
	}
}

// TestHelloIncludesVersion asserts that connectOnce embeds the configured
// version string in the hello frame it sends, under the "version" JSON key.
// This is the wire interface consumed by the hub (Task 2, slice 1).
func TestHelloIncludesVersion(t *testing.T) {
	const wantVersion = "v0.1.1-test"

	got := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		_, data, err := c.Read(context.Background())
		if err != nil {
			return
		}
		got <- string(data)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg := config.Config{Hub: srv.URL, NodeID: "n", NodeSecret: "s"}
	go Run(ctx, cfg, stubHandler, wantVersion, nil)

	select {
	case msg := <-got:
		var frame map[string]any
		if err := json.Unmarshal([]byte(msg), &frame); err != nil {
			t.Fatalf("hello not valid JSON: %v", err)
		}
		gotVer, ok := frame["version"]
		if !ok {
			t.Fatalf("hello frame missing \"version\" field; got: %s", msg)
		}
		if gotVer != wantVersion {
			t.Fatalf("hello[\"version\"] = %q, want %q", gotVer, wantVersion)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no hello received")
	}
}

// A frame far over the websocket library's 32 KiB default — the size of an
// ACP prompt carrying an image — must be read and answered, not close the
// connection. It closed it on ashram on 2026-09-24, mid-turn, for every
// station on the node.
func TestGatewayReadsLargeFrames(t *testing.T) {
	answered := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		ctx := context.Background()
		if _, _, err := c.Read(ctx); err != nil { // hello
			return
		}
		big := strings.Repeat("A", 3<<20)
		frame := `{"type":"req","id":"big-1","verb":"no.such.verb","params":{"blob":"` + big + `"}}`
		if err := c.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
			return
		}
		for {
			readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			_, data, err := c.Read(readCtx)
			cancel()
			if err != nil {
				answered <- "closed: " + err.Error()
				return
			}
			if strings.Contains(string(data), `"big-1"`) {
				answered <- "answered"
				return
			}
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Run(ctx, config.Config{Hub: srv.URL, NodeID: "node_1", NodeSecret: "s"}, stubHandler, "dev", nil)

	select {
	case got := <-answered:
		if got != "answered" {
			t.Fatalf("a 3 MiB frame was not answered: %s", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no answer to the large frame")
	}
}

func TestHelloAdvertisesLargeFrames(t *testing.T) {
	found := false
	for _, c := range NodeCapabilities {
		if c == "frames.large" {
			found = true
		}
	}
	if !found {
		t.Fatal(`NodeCapabilities must include "frames.large": the hub sends images only to nodes that say they can read them`)
	}
}

