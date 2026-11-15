package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

func TestCheckpointBrokenExplicitPinNeverFallsThroughToACP(t *testing.T) {
	calls := 0
	next := gateway.HandlerFunc(func(context.Context, string, json.RawMessage, func(int, string, bool, string) error) (any, bool, error) {
		calls++
		return "ordinary", false, nil
	})
	h, close := checkpointCoordinatorHandler(next, config.Config{ProposedCheckpointRegistry: "/missing/private/registry"})
	defer close()
	raw := json.RawMessage(`{"version":"agentpod.bench-coordinator.v1","operation":"ready","tenant_id":"fleet_fixture","board_id":"brd_fixture001","station_id":"station_fixture"}`)
	value, streamed, err := h.Handle(context.Background(), benchcoordinatorwire.Verb, raw, nil)
	response, ok := value.(benchcoordinatorwire.Response)
	if err != nil || streamed || !ok || response.State != "refused" || calls != 0 {
		t.Fatal("broken dedicated pin entered generic dispatch")
	}
	if _, _, err = h.Handle(context.Background(), "health", nil, nil); err != nil || calls != 1 {
		t.Fatal("ordinary dispatch changed")
	}
	disabled, close := checkpointCoordinatorHandler(next, config.Config{})
	defer close()
	if _, _, err = disabled.Handle(context.Background(), "health", nil, nil); err != nil || calls != 2 {
		t.Fatal("default dispatch changed")
	}
}
