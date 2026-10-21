package descriptor

import (
	"context"
	"encoding/json"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Explicit disposable input only. This test does not detect a live station,
// discover credentials, start a daemon, or generate source/package transfers.
func TestReviewedSalaamConfigurationRealCLI(t *testing.T) {
	path := os.Getenv("SALAAM_M22_HOST_CONFIG_FIXTURE")
	if path == "" {
		t.Skip("requires isolated offline reviewed host fixture")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Node      string `json:"node"`
		CLI       string `json:"cli"`
		Manifest  string `json:"manifest"`
		State     string `json:"state"`
		Workspace string `json:"workspace"`
		NodeID    string `json:"node_id"`
		Target    any    `json:"target"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(root, "/private/tmp/salaam-m22-") {
		t.Fatal("real CLI configuration test requires a disposable /private/tmp/salaam-m22-* root")
	}
	for _, owned := range []string{f.Manifest, f.State, f.Workspace} {
		if !strings.HasPrefix(owned, root+string(filepath.Separator)) {
			t.Fatal("fixture cannot edit an existing station outside its disposable root")
		}
	}
	target, ok := f.Target.(map[string]any)
	if !ok {
		t.Fatal("fixture target is not a manifest")
	}
	provider, ok := target["provider"].(map[string]any)
	if !ok || provider["provider"] != "salaam-proof" {
		t.Fatal("real CLI configuration test requires offline provider")
	}
	s := NewSalaamFrom(SalaamConfig{Binary: f.CLI, NodeBinary: f.Node, Manifest: f.Manifest, StateDir: f.State, Workspace: f.Workspace, NodeID: f.NodeID}).(ConfigManager)
	ctx := context.Background()
	key := salaam.StationKey(f.Workspace)
	before, err := s.ObserveConfig(ctx, key, []string{salaamHostManifestSetting})
	if err != nil || len(before) != 1 || !before[0].Readable {
		t.Fatalf("observe before: %+v %v", before, err)
	}
	plan, err := s.PlanConfig(ctx, key, "m22-real-go-cli", []DeclaredSetting{{SettingID: salaamHostManifestSetting, Value: f.Target}})
	if err != nil || plan.Refusal != nil || plan.NoOp || !plan.RestartRequired {
		t.Fatalf("real native plan: %+v %v", plan, err)
	}
	receipt, err := s.ApplyConfig(ctx, key, plan.OperationID, plan.PlanDigest)
	if err != nil || receipt.Phase != "applied" {
		t.Fatalf("real native apply: %+v %v", receipt, err)
	}
	observer := s.(*salaamDescriptor)
	for i := 0; i < 2; i++ {
		detected, err := observer.Detect()
		if err != nil || len(detected) != 1 {
			t.Fatalf("applied stopped station disappeared: %+v %v", detected, err)
		}
		health, err := observer.Health(key)
		if err != nil || health.Running || health.PID != nil {
			t.Fatalf("post-apply observation activated daemon: %+v %v", health, err)
		}
	}
	if _, err := os.Stat(filepath.Join(f.State, "operator.sock")); !os.IsNotExist(err) {
		t.Fatal("post-apply polling created a daemon socket")
	}
	after, err := s.ObserveConfig(ctx, key, []string{salaamHostManifestSetting})
	if err != nil || len(after) != 1 || !reflect.DeepEqual(after[0].Observed, f.Target) {
		t.Fatalf("observe after: %+v %v", after, err)
	}
	inspected, err := s.InspectConfig(ctx, key, plan.OperationID)
	if err != nil || !reflect.DeepEqual(inspected, receipt) {
		t.Fatalf("real native inspect: %+v %v", inspected, err)
	}
	repeat, err := s.ApplyConfig(ctx, key, plan.OperationID, plan.PlanDigest)
	if err != nil || !reflect.DeepEqual(repeat, receipt) {
		t.Fatalf("real native replay: %+v %v", repeat, err)
	}
	wrong, err := s.ApplyConfig(ctx, key, plan.OperationID, "wrong")
	if err != nil || wrong.Phase != "conflict" {
		t.Fatalf("wrong digest: %+v %v", wrong, err)
	}
	t.Log("actual ConfigManager -> pinned Node/native Salaam CLI observe/plan/apply/inspect/replay accepted; wrong digest refused; no daemon started")
}

// The producer proof keeps two disposable ready sessions alive while this
// passive node consumer reads their actual private operator API.
func TestReviewedSalaamContextInventoryRealAPI(t *testing.T) {
	path := os.Getenv("SALAAM_M22_CONTEXT_HOST_FIXTURE")
	if path == "" {
		t.Skip("requires disposable running offline context producer fixture")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		State            string   `json:"state"`
		Workspace        string   `json:"workspace"`
		NodeID           string   `json:"node_id"`
		ExpectedSkill    string   `json:"expected_skill"`
		ExpectedSessions []string `json:"expected_sessions"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(f.State, "/private/tmp/salaam-m22-") || len(f.ExpectedSessions) < 2 {
		t.Fatal("requires two explicitly named disposable producer sessions")
	}
	c := &salaam.Client{State: f.State, Workspace: f.Workspace, NodeID: f.NodeID}
	inventory, err := c.SkillInventory(context.Background(), salaam.StationKey(f.Workspace))
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, skill := range inventory.Skills {
		if skill.Name != f.ExpectedSkill {
			continue
		}
		found = true
		if skill.Evidence.Loaded.Value == nil || !*skill.Evidence.Loaded.Value || skill.Evidence.Exercised.Value != nil {
			t.Fatalf("actual provider evidence did not reach node consumer: %+v", skill.Evidence)
		}
		for _, id := range f.ExpectedSessions {
			if !strings.Contains(skill.Evidence.Loaded.Reason, id) {
				t.Fatalf("lost actual producer session %s in %+v", id, skill.Evidence.Loaded)
			}
		}
	}
	if !found {
		t.Fatalf("expected skill %s absent from actual producer inventory: %+v", f.ExpectedSkill, inventory)
	}
	t.Log("actual two-session verified provider-payload admission -> private Salaam API -> Go skills.inventory consumer accepted; exercised remains unknown")
}
