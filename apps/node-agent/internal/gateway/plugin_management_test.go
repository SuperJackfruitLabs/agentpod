package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
)

func pluginTestHandler(t *testing.T) (Handler, string) {
	t.Helper()
	profile := t.TempDir()
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("model: fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := NewPluginManagementHandler(changesetPassthrough(), PluginManagementDeps{
		NodeID: "fixture-node",
		ProfileDir: func(ctx context.Context, key string) (string, error) {
			if key != "hermes:fixture" {
				return "", fmt.Errorf("not detected")
			}
			return profile, ctx.Err()
		},
		Gate: func(context.Context) hermeslive.Gate {
			return hermeslive.Gate{Allowed: true, Version: "0.21.3", Reason: "fixture"}
		},
	})
	return h, profile
}

func TestPluginManagementPlansAppliesAndInspects(t *testing.T) {
	h, profile := pluginTestHandler(t)
	id := strings.Repeat("a", 32)
	base := map[string]string{"key": "hermes:fixture", "plugin": hermeslive.Name, "operationId": id}
	with := func(k, v string) map[string]string {
		params := map[string]string{k: v}
		for key, value := range base {
			params[key] = value
		}
		return params
	}
	if result, err := skillCall(t, h, "plugins.operation", base); err != nil || result.(PluginOperationResult).Receipt != nil {
		t.Fatalf("inspect before plan = %+v, %v", result, err)
	}
	result, err := skillCall(t, h, "plugins.plan", with("action", "enable"))
	if err != nil {
		t.Fatal(err)
	}
	plan := result.(hermeslive.OperationPlan)
	if plan.Binding.NodeID != "fixture-node" || plan.Binding.StationKey != "hermes:fixture" || plan.Binding.Plugin != hermeslive.Name || plan.OperationID != id {
		t.Fatalf("plan binding = %+v", plan)
	}
	if _, err := os.Stat(filepath.Join(profile, "plugins")); !os.IsNotExist(err) {
		t.Fatal("planning wrote the plugin")
	}
	result, err = skillCall(t, h, "plugins.apply", with("expectedPlanDigest", plan.PlanDigest))
	if err != nil || result.(hermeslive.OperationReceipt).Phase != "applied" {
		t.Fatalf("apply = %+v, %v", result, err)
	}
	result, err = skillCall(t, h, "plugins.operation", base)
	if err != nil || result.(PluginOperationResult).Receipt.Phase != "applied" {
		t.Fatalf("inspect = %+v, %v", result, err)
	}
	if _, err := os.Stat(filepath.Join(profile, "plugins", hermeslive.Name)); err != nil {
		t.Fatal("the plugin was not installed")
	}
	if out, _ := json.Marshal(result); !strings.Contains(string(out), `"receipt":{"plan":`) {
		t.Fatalf("wire shape = %s", out)
	}
}

func TestPluginManagementParamsAreStrict(t *testing.T) {
	h, _ := pluginTestHandler(t)
	id := strings.Repeat("a", 32)
	for name, raw := range map[string]string{
		"unknown field":   `{"key":"hermes:fixture","plugin":"agentpod-live","operationId":"` + id + `","action":"enable","path":"/tmp"}`,
		"duplicate key":   `{"key":"hermes:fixture","key":"hermes:other","plugin":"agentpod-live","operationId":"` + id + `","action":"enable"}`,
		"other plugin":    `{"key":"hermes:fixture","plugin":"other","operationId":"` + id + `","action":"enable"}`,
		"unknown action":  `{"key":"hermes:fixture","plugin":"agentpod-live","operationId":"` + id + `","action":"install"}`,
		"missing action":  `{"key":"hermes:fixture","plugin":"agentpod-live","operationId":"` + id + `"}`,
		"bad operationId": `{"key":"hermes:fixture","plugin":"agentpod-live","operationId":"../x","action":"enable"}`,
		"trailing value":  `{"key":"hermes:fixture","plugin":"agentpod-live","operationId":"` + id + `","action":"enable"} {}`,
	} {
		if _, _, err := h.Handle(t.Context(), "plugins.plan", json.RawMessage(raw), nil); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := skillCall(t, h, "plugins.plan", map[string]string{"key": "hermes:other", "plugin": hermeslive.Name, "operationId": id, "action": "enable"}); err == nil {
		t.Error("an undetected station was planned")
	}
	if result, err := skillCall(t, h, "other.verb", nil); err != nil || result != "inner:other.verb" {
		t.Errorf("other verbs are not passed through: %v, %v", result, err)
	}
}
