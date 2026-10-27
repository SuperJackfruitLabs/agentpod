package descriptor

import (
	"context"
	"encoding/json"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSalaamConfigManagerDelegatesReviewedNativeCommands(t *testing.T) {
	s := &salaamDescriptor{config: SalaamConfig{Binary: "/private/salaam.mjs", NodeBinary: "/private/node", Manifest: "/private/host.json", StateDir: "/private/state", Workspace: "/private/work", NodeID: "node_fixture"}}
	var _ ConfigManager = s
	if got := s.ConfigSettings(); len(got) != 6 || got[5].ID != "salaam.host.manifest" || !got[5].RestartToTakeEffect || got[5].Policy != "reconcilable" {
		t.Fatalf("registry: %+v", got)
	}
	key := salaam.StationKey(s.config.Workspace)
	calls := 0
	s.configure = func(ctx context.Context, action string, request any) ([]byte, error) {
		calls++
		encoded, _ := json.Marshal(request)
		var params map[string]any
		_ = json.Unmarshal(encoded, &params)
		if params["stationKey"] != key {
			t.Fatalf("unbound request: %s", encoded)
		}
		switch action {
		case "observe":
			return []byte(`{"values":[{"settingId":"salaam.host.manifest","readable":true,"observed":{"schema":2}}]}`), nil
		case "plan":
			return json.Marshal(ConfigPlan{SchemaVersion: 1, StationKey: key, OperationID: "review", PlanDigest: "reviewed", RestartRequired: true})
		case "apply", "inspect":
			return json.Marshal(ConfigReceipt{Plan: ConfigPlan{SchemaVersion: 1, StationKey: key, OperationID: "review", PlanDigest: "reviewed"}, Phase: "applied"})
		}
		t.Fatalf("unexpected action %s", action)
		return nil, nil
	}
	ctx := context.Background()
	if _, err := s.ObserveConfig(ctx, key, []string{"salaam.host.manifest"}); err != nil {
		t.Fatal(err)
	}
	p, err := s.PlanConfig(ctx, key, "review", []DeclaredSetting{{SettingID: "salaam.host.manifest", Value: map[string]any{"schema": 2}}})
	if err != nil || p.PlanDigest != "reviewed" {
		t.Fatalf("plan: %+v %v", p, err)
	}
	if _, err := s.ApplyConfig(ctx, key, "review", "reviewed"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InspectConfig(ctx, key, "review"); err != nil {
		t.Fatal(err)
	}
	if calls != 4 {
		t.Fatal(calls)
	}
	if _, err := s.ObserveConfig(ctx, "salaam:foreign", nil); err == nil || calls != 4 {
		t.Fatal("foreign station invoked native command")
	}
	if _, err := s.ObserveConfig(ctx, key, []string{"auth.json"}); err == nil || calls != 4 {
		t.Fatal("unknown setting invoked native command")
	}
	s.configure = func(context.Context, string, any) ([]byte, error) {
		return []byte(`{"plan":{"stationKey":"foreign","operationId":"review"},"phase":"applied"}`), nil
	}
	if _, err := s.InspectConfig(ctx, key, "review"); err == nil {
		t.Fatal("foreign receipt accepted")
	}
}

func TestSalaamDetectionAndHealthNeverActivateConfiguredStoppedHost(t *testing.T) {
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	node, err := filepath.EvalSymlinks("/bin/sh")
	if err != nil {
		t.Fatal(err)
	}
	cli, manifest, marker := filepath.Join(root, "salaam"), filepath.Join(root, "manifest.json"), filepath.Join(root, "started")
	workspace, state := filepath.Join(root, "workspace"), filepath.Join(root, "state")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	result, _ := json.Marshal(map[string]any{"version": 1, "ready": true, "node": node, "cli": cli, "state": state, "workspace": workspace, "node_id": "fixture", "manifest_digest": strings.Repeat("a", 64), "pins_digest": strings.Repeat("b", 64)})
	script := "test \"$1\" = host || exit 1\ntest \"$2\" = start || exit 2\necho started > '" + marker + "'\ncat <<'RECEIPT'\n" + string(result) + "\nRECEIPT\n"
	if err := os.WriteFile(cli, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifest, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	s := NewSalaamFrom(SalaamConfig{Binary: cli, NodeBinary: node, Manifest: manifest, StateDir: state, Workspace: workspace, NodeID: "fixture"}).(*salaamDescriptor)
	key := salaam.StationKey(workspace)
	for i := 0; i < 3; i++ {
		stations, err := s.Detect()
		if err != nil || len(stations) != 1 {
			t.Fatalf("configured stopped station disappeared: %+v %v", stations, err)
		}
		health, err := s.Health(key)
		if err != nil || health.Running || health.PID != nil || health.ConfigurationDigest != "" {
			t.Fatalf("stopped installation claimed readiness: %+v %v", health, err)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("observation started host")
	}
	if _, _, _, err := s.ACPCommand(key); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("explicit ACP use did not reach existing reviewed startup boundary")
	}
}
