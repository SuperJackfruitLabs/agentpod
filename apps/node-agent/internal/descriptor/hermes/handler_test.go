package hermes

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

func TestHandlerConfigObserve_RoutesToDescriptor(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("approvals:\n  timeout: 300\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := descriptor.NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := descriptor.NewHandler(reg)
	params := json.RawMessage(`{"stationKey":"hermes:one","settings":["hermes.approvals.timeout"]}`)
	result, streamed, err := h.Handle(context.Background(), "config.observe", params, nil)
	if err != nil {
		t.Fatalf("config.observe: %v", err)
	}
	if streamed {
		t.Fatal("config.observe should not be streamed")
	}
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected map, got %T", result)
	}
	values, ok := m["values"].([]descriptor.ConfigValue)
	if !ok {
		t.Fatalf("expected []ConfigValue under \"values\", got %T", m["values"])
	}
	if len(values) != 1 || values[0].SettingID != "hermes.approvals.timeout" {
		t.Fatalf("unexpected values: %+v", values)
	}
	if !values[0].Readable {
		t.Fatalf("expected readable value, got %+v", values[0])
	}
	if values[0].Observed != "300" {
		t.Fatalf("expected observed \"300\", got %v (%T)", values[0].Observed, values[0].Observed)
	}
}

func TestHandlerConfigSettings_RoutesToDescriptor(t *testing.T) {
	home := t.TempDir()
	reg := descriptor.NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := descriptor.NewHandler(reg)
	params := json.RawMessage(`{"stationKey":"hermes:one"}`)
	result, streamed, err := h.Handle(context.Background(), "config.settings", params, nil)
	if err != nil {
		t.Fatalf("config.settings: %v", err)
	}
	if streamed {
		t.Fatal("config.settings should not be streamed")
	}
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected map, got %T", result)
	}
	settings, ok := m["settings"].([]descriptor.ConfigSetting)
	if !ok {
		t.Fatalf("expected []ConfigSetting under \"settings\", got %T", m["settings"])
	}
	if len(settings) == 0 {
		t.Fatal("expected at least one registered setting")
	}
	found := false
	for _, s := range settings {
		if s.ID == "hermes.approvals.timeout" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected hermes.approvals.timeout in the registry, got %+v", settings)
	}
}

func TestHandlerConfigPlan_RoutesToDescriptor(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("approvals:\n  timeout: 300\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := descriptor.NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := descriptor.NewHandler(reg)
	params := json.RawMessage(`{"stationKey":"hermes:one","operationId":"test-op-1","want":[{"settingId":"hermes.approvals.timeout","value":"600"}]}`)
	result, streamed, err := h.Handle(context.Background(), "config.plan", params, nil)
	if err != nil {
		t.Fatalf("config.plan: %v", err)
	}
	if streamed {
		t.Fatal("config.plan should not be streamed")
	}
	plan, ok := result.(descriptor.ConfigPlan)
	if !ok {
		t.Fatalf("expected ConfigPlan, got %T", result)
	}
	if plan.OperationID != "test-op-1" {
		t.Fatalf("expected operationId test-op-1, got %s", plan.OperationID)
	}
	if plan.StationKey != "hermes:one" {
		t.Fatalf("expected stationKey hermes:one, got %s", plan.StationKey)
	}
}

func TestHandlerConfigInspect_RoutesToDescriptor(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("approvals:\n  timeout: 300\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := descriptor.NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := descriptor.NewHandler(reg)
	// First plan an operation so it exists in the journal
	planParams := json.RawMessage(`{"stationKey":"hermes:one","operationId":"test-op-2","want":[{"settingId":"hermes.approvals.timeout","value":"600"}]}`)
	_, _, err := h.Handle(context.Background(), "config.plan", planParams, nil)
	if err != nil {
		t.Fatalf("config.plan setup: %v", err)
	}

	// Now inspect the operation
	params := json.RawMessage(`{"stationKey":"hermes:one","operationId":"test-op-2"}`)
	result, streamed, err := h.Handle(context.Background(), "config.inspect", params, nil)
	if err != nil {
		t.Fatalf("config.inspect: %v", err)
	}
	if streamed {
		t.Fatal("config.inspect should not be streamed")
	}
	receipt, ok := result.(descriptor.ConfigReceipt)
	if !ok {
		t.Fatalf("expected ConfigReceipt, got %T", result)
	}
	if receipt.Plan.OperationID != "test-op-2" {
		t.Fatalf("expected operationId test-op-2, got %s", receipt.Plan.OperationID)
	}
}

func TestHandlerConfigApply_RoutesToDescriptor(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("approvals:\n  timeout: 300\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := descriptor.NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := descriptor.NewHandler(reg)
	// First plan an operation
	planParams := json.RawMessage(`{"stationKey":"hermes:one","operationId":"test-op-3","want":[{"settingId":"hermes.approvals.timeout","value":"600"}]}`)
	planResult, _, err := h.Handle(context.Background(), "config.plan", planParams, nil)
	if err != nil {
		t.Fatalf("config.plan setup: %v", err)
	}
	plan, ok := planResult.(descriptor.ConfigPlan)
	if !ok {
		t.Fatalf("expected ConfigPlan, got %T", planResult)
	}

	// Now apply the plan
	params := json.RawMessage(`{"stationKey":"hermes:one","operationId":"test-op-3","planDigest":"` + plan.PlanDigest + `"}`)
	result, streamed, err := h.Handle(context.Background(), "config.apply", params, nil)
	if err != nil {
		t.Fatalf("config.apply: %v", err)
	}
	if streamed {
		t.Fatal("config.apply should not be streamed")
	}
	receipt, ok := result.(descriptor.ConfigReceipt)
	if !ok {
		t.Fatalf("expected ConfigReceipt, got %T", result)
	}
	if receipt.Plan.OperationID != "test-op-3" {
		t.Fatalf("expected operationId test-op-3, got %s", receipt.Plan.OperationID)
	}
}
