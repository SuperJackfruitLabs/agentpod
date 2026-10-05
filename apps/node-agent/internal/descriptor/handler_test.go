package descriptor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandlerDetect_ReturnsList(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{
		harness: "fake",
		stations: []Station{
			{Key: "fake:s1", Harness: "fake", Kind: "agent", DisplayName: "S1", Capabilities: []string{}},
		},
	})

	h := NewHandler(reg)
	result, streamed, err := h.Handle(context.Background(), "detect", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if streamed {
		t.Fatal("detect should not be streamed")
	}
	stations, ok := result.([]Station)
	if !ok {
		t.Fatalf("expected []Station, got %T", result)
	}
	if len(stations) != 1 || stations[0].Key != "fake:s1" {
		t.Fatalf("unexpected stations: %+v", stations)
	}
}

func TestHandlerDetect_EmptyWhenNoDescriptors(t *testing.T) {
	reg := NewRegistry()
	h := NewHandler(reg)
	result, _, err := h.Handle(context.Background(), "detect", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("detect empty: %v", err)
	}
	stations, ok := result.([]Station)
	if !ok {
		t.Fatalf("expected []Station, got %T", result)
	}
	if len(stations) != 0 {
		t.Fatalf("expected empty, got %d stations", len(stations))
	}
}

func TestHandlerFsList_RoutesToDescriptor(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})

	h := NewHandler(reg)
	params := json.RawMessage(`{"key":"fake:s1","path":"/workspace"}`)
	result, streamed, err := h.Handle(context.Background(), "fs.list", params, nil)
	if err != nil {
		t.Fatalf("fs.list: %v", err)
	}
	if streamed {
		t.Fatal("fs.list should not be streamed")
	}
	entries, ok := result.([]FsEntry)
	if !ok {
		t.Fatalf("expected []FsEntry, got %T", result)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least one entry")
	}
	if entries[0].Name != "file.txt" {
		t.Fatalf("unexpected entry name: %s", entries[0].Name)
	}
}

func TestHandlerFsRead_ReturnsContentAndEncoding(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})

	h := NewHandler(reg)
	params := json.RawMessage(`{"key":"fake:s1","path":"file.txt","maxBytes":1048576}`)
	result, streamed, err := h.Handle(context.Background(), "fs.read", params, nil)
	if err != nil {
		t.Fatalf("fs.read: %v", err)
	}
	if streamed {
		t.Fatal("fs.read should not be streamed")
	}
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected map, got %T", result)
	}
	if m["encoding"] != "utf8" {
		t.Fatalf("expected encoding utf8, got %v", m["encoding"])
	}
	if m["content"] != "hello" {
		t.Fatalf("expected content hello, got %v", m["content"])
	}
	if m["truncated"] != false {
		t.Fatalf("expected truncated false, got %v", m["truncated"])
	}
}

func TestHandlerLogsTail_IsStreamed(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})

	var chunks []string
	emit := func(seq int, chunk string, eof bool, enc string) error {
		chunks = append(chunks, chunk)
		return nil
	}

	h := NewHandler(reg)
	params := json.RawMessage(`{"key":"fake:s1","follow":false}`)
	_, streamed, err := h.Handle(context.Background(), "logs.tail", params, emit)
	if err != nil {
		t.Fatalf("logs.tail: %v", err)
	}
	if !streamed {
		t.Fatal("logs.tail should be streamed")
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least one chunk emitted")
	}
}

func TestHandlerConfigObserve_RoutesToDescriptor(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("approvals:\n  timeout: 300\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := NewHandler(reg)
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
	values, ok := m["values"].([]ConfigValue)
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

func TestHandlerConfigObserve_UnsupportedHarnessReturnsError(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})

	h := NewHandler(reg)
	params := json.RawMessage(`{"stationKey":"fake:s1","settings":["anything"]}`)
	_, _, err := h.Handle(context.Background(), "config.observe", params, nil)
	if err == nil {
		t.Fatal("expected error: fake descriptor does not implement ConfigManager")
	}
}

func TestHandlerConfigSettings_RoutesToDescriptor(t *testing.T) {
	home := t.TempDir()
	reg := NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := NewHandler(reg)
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
	settings, ok := m["settings"].([]ConfigSetting)
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

func TestHandlerConfigSettings_UnsupportedHarnessReturnsError(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})

	h := NewHandler(reg)
	params := json.RawMessage(`{"stationKey":"fake:s1"}`)
	_, _, err := h.Handle(context.Background(), "config.settings", params, nil)
	if err == nil {
		t.Fatal("expected error: fake descriptor does not implement ConfigManager")
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
	reg := NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := NewHandler(reg)
	params := json.RawMessage(`{"stationKey":"hermes:one","operationId":"test-op-1","want":[{"settingId":"hermes.approvals.timeout","value":"600"}]}`)
	result, streamed, err := h.Handle(context.Background(), "config.plan", params, nil)
	if err != nil {
		t.Fatalf("config.plan: %v", err)
	}
	if streamed {
		t.Fatal("config.plan should not be streamed")
	}
	plan, ok := result.(ConfigPlan)
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

func TestHandlerConfigPlan_UnsupportedHarnessReturnsError(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})

	h := NewHandler(reg)
	params := json.RawMessage(`{"stationKey":"fake:s1","operationId":"test-op","want":[{"settingId":"foo","value":"bar"}]}`)
	_, _, err := h.Handle(context.Background(), "config.plan", params, nil)
	if err == nil {
		t.Fatal("expected error: fake descriptor does not implement ConfigManager")
	}
	if !contains(err.Error(), "does not manage configuration") {
		t.Fatalf("expected error about managing configuration, got: %v", err)
	}
}

func TestHandlerConfigPlan_BadParamsError(t *testing.T) {
	reg := NewRegistry()
	h := NewHandler(reg)
	params := json.RawMessage(`{"invalid json"}`)
	_, _, err := h.Handle(context.Background(), "config.plan", params, nil)
	if err == nil {
		t.Fatal("expected error for bad params")
	}
	if !contains(err.Error(), "bad params") {
		t.Fatalf("expected 'bad params' error, got: %v", err)
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
	reg := NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := NewHandler(reg)
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
	receipt, ok := result.(ConfigReceipt)
	if !ok {
		t.Fatalf("expected ConfigReceipt, got %T", result)
	}
	if receipt.Plan.OperationID != "test-op-2" {
		t.Fatalf("expected operationId test-op-2, got %s", receipt.Plan.OperationID)
	}
}

func TestHandlerConfigInspect_UnsupportedHarnessReturnsError(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})

	h := NewHandler(reg)
	params := json.RawMessage(`{"stationKey":"fake:s1","operationId":"test-op"}`)
	_, _, err := h.Handle(context.Background(), "config.inspect", params, nil)
	if err == nil {
		t.Fatal("expected error: fake descriptor does not implement ConfigManager")
	}
	if !contains(err.Error(), "does not manage configuration") {
		t.Fatalf("expected error about managing configuration, got: %v", err)
	}
}

func TestHandlerConfigInspect_BadParamsError(t *testing.T) {
	reg := NewRegistry()
	h := NewHandler(reg)
	params := json.RawMessage(`{"invalid json"}`)
	_, _, err := h.Handle(context.Background(), "config.inspect", params, nil)
	if err == nil {
		t.Fatal("expected error for bad params")
	}
	if !contains(err.Error(), "bad params") {
		t.Fatalf("expected 'bad params' error, got: %v", err)
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
	reg := NewRegistry()
	reg.Register(NewHermes(home, ""))

	h := NewHandler(reg)
	// First plan an operation
	planParams := json.RawMessage(`{"stationKey":"hermes:one","operationId":"test-op-3","want":[{"settingId":"hermes.approvals.timeout","value":"600"}]}`)
	planResult, _, err := h.Handle(context.Background(), "config.plan", planParams, nil)
	if err != nil {
		t.Fatalf("config.plan setup: %v", err)
	}
	plan, ok := planResult.(ConfigPlan)
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
	receipt, ok := result.(ConfigReceipt)
	if !ok {
		t.Fatalf("expected ConfigReceipt, got %T", result)
	}
	if receipt.Plan.OperationID != "test-op-3" {
		t.Fatalf("expected operationId test-op-3, got %s", receipt.Plan.OperationID)
	}
}

func TestHandlerConfigApply_UnsupportedHarnessReturnsError(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})

	h := NewHandler(reg)
	params := json.RawMessage(`{"stationKey":"fake:s1","operationId":"test-op","planDigest":"abc123"}`)
	_, _, err := h.Handle(context.Background(), "config.apply", params, nil)
	if err == nil {
		t.Fatal("expected error: fake descriptor does not implement ConfigManager")
	}
	if !contains(err.Error(), "does not manage configuration") {
		t.Fatalf("expected error about managing configuration, got: %v", err)
	}
}

func TestHandlerConfigApply_BadParamsError(t *testing.T) {
	reg := NewRegistry()
	h := NewHandler(reg)
	params := json.RawMessage(`{"invalid json"}`)
	_, _, err := h.Handle(context.Background(), "config.apply", params, nil)
	if err == nil {
		t.Fatal("expected error for bad params")
	}
	if !contains(err.Error(), "bad params") {
		t.Fatalf("expected 'bad params' error, got: %v", err)
	}
}

func TestHandlerUnknownVerb_ReturnsError(t *testing.T) {
	reg := NewRegistry()
	h := NewHandler(reg)
	_, _, err := h.Handle(context.Background(), "nosuchverb", json.RawMessage(`{}`), nil)
	if err == nil {
		t.Fatal("expected error for unknown verb")
	}
}

// contains is a helper to check if a string is in another string.
func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}
