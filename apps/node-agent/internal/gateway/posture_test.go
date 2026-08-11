package gateway

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/posture"
)

func posturePassthrough() Handler {
	return HandlerFunc(func(_ context.Context, verb string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		return "inner:" + verb, false, nil
	})
}

func TestPostureHandlerPassesOtherVerbsThrough(t *testing.T) {
	h := NewPostureHandler(posturePassthrough(), func() int { return 0 })
	got, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if got != "inner:health" {
		t.Errorf("got %v, want the inner handler's result", got)
	}
}

func TestPostureScanReturnsAGradedReport(t *testing.T) {
	h := NewPostureHandler(posturePassthrough(), func() int { return 7 })
	got, streamed, err := h.Handle(t.Context(), "posture.scan", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if streamed {
		t.Error("posture.scan returns a bounded result; it must not stream")
	}
	rep, ok := got.(posture.Report)
	if !ok {
		t.Fatalf("got %T, want posture.Report", got)
	}
	if rep.Grade == "" {
		t.Error("report has no grade")
	}
	if rep.Stations != 7 {
		t.Errorf("Stations = %d, want the injected count 7", rep.Stations)
	}
}

func TestPostureScanIgnoresParams(t *testing.T) {
	// The verb takes {} — a node-level scan has nothing to key on. Junk params
	// must not fail it, so an older or newer caller stays compatible.
	h := NewPostureHandler(posturePassthrough(), func() int { return 0 })
	if _, _, err := h.Handle(t.Context(), "posture.scan", json.RawMessage(`{"key":"ignored"}`), nil); err != nil {
		t.Fatalf("Handle: %v", err)
	}
}

func TestNodeCapabilitiesAdvertisesPosture(t *testing.T) {
	// This is what the hub gates the console panel on.
	var found bool
	for _, c := range NodeCapabilities {
		if c == "posture" {
			found = true
		}
	}
	if !found {
		t.Errorf("NodeCapabilities = %v, want it to include posture", NodeCapabilities)
	}
}

func TestHelloCarriesNodeCapabilities(t *testing.T) {
	// The frame used to be an inline map[string]any, which meant nothing could
	// catch it drifting from the contract. It is a struct now; this pins that
	// capabilities actually reach the wire.
	b, err := json.Marshal(HelloMsg{Type: "hello", Version: "v0.1.22", Capabilities: NodeCapabilities})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	caps, ok := back["capabilities"].([]any)
	if !ok || len(caps) == 0 {
		t.Fatalf("hello frame carried no capabilities: %s", b)
	}
}
