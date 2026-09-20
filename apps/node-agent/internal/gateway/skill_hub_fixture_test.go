package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"testing"
)

// TestSkillHubFixture is an opt-in subprocess for the hub's real HTTP/broker
// integration probe. It uses no enrolled-node files or live harness settings.
// Run through apps/hub/tests/integration/skills-node-e2e.ts, not by hand.
func TestSkillHubFixture(t *testing.T) {
	if os.Getenv("SJL_SKILL_HUB_FIXTURE") != "1" {
		return
	}
	nodeID := os.Getenv("SJL_SKILL_FIXTURE_NODE")
	fetch, err := NewHTTPArtifactFetcher(os.Getenv("SJL_SKILL_FIXTURE_HUB"), nodeID, os.Getenv("SJL_SKILL_FIXTURE_SECRET"))
	if err != nil {
		t.Fatal(err)
	}
	inner := HandlerFunc(func(context.Context, string, json.RawMessage, func(int, string, bool, string) error) (any, bool, error) {
		return nil, false, fmt.Errorf("unsupported fixture verb")
	})
	h := NewSkillManagementHandler(inner, SkillManagementDeps{NodeID: nodeID, Fetch: fetch, Resolve: func(ctx context.Context, key string) (string, string, error) {
		if key != "codex:fixture" {
			return "", "", fmt.Errorf("fixture station not detected")
		}
		return os.Getenv("SJL_SKILL_FIXTURE_WORKSPACE"), "codex", ctx.Err()
	}})
	decoder, encoder := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var request struct {
			ID     string          `json:"id"`
			Verb   string          `json:"verb"`
			Params json.RawMessage `json:"params"`
		}
		if err := decoder.Decode(&request); err == io.EOF {
			return
		} else if err != nil {
			t.Fatal(err)
		}
		result, _, err := h.Handle(context.Background(), request.Verb, request.Params, nil)
		response := map[string]any{"type": "res", "id": request.ID, "ok": err == nil}
		if err != nil {
			response["error"] = err.Error()
		} else {
			response["data"] = result
		}
		if err := encoder.Encode(response); err != nil {
			t.Fatal(err)
		}
	}
}
