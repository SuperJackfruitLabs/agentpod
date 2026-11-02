package hermes

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
)

func TestSkillInventoryIsOptionalAndScopedToDetectedStation(t *testing.T) {
	home := t.TempDir()
	skill := filepath.Join(home, "profiles", "writer", "skills", "example")
	if err := os.MkdirAll(skill, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: example\ndescription: A fixture\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	d := NewHermes(home)
	provider, ok := d.(descriptor.SkillInventoryProvider)
	if !ok {
		t.Fatal("optional provider missing")
	}
	result, err := provider.SkillInventory(context.Background(), "hermes:writer")
	if err != nil || len(result.Skills) != 1 {
		t.Fatalf("%+v %v", result, err)
	}
	if result.Skills[0].Scope != "profile" {
		t.Fatal("profile scope lost")
	}
	for _, key := range []string{"hermes:absent", "hermes:../writer", "hermes:../../other", "openclaw:writer"} {
		if _, err := provider.SkillInventory(context.Background(), key); err == nil {
			t.Fatalf("accepted %q", key)
		}
	}
	reg := descriptor.NewRegistry()
	reg.Register(d)
	h := descriptor.NewHandler(reg)
	for _, params := range []string{`{}`, `{"key":""}`, `{"key":"hermes:writer","path":"/other"}`, `{"key":"hermes:writer"} {}`} {
		if _, _, err := h.Handle(context.Background(), "skills.inventory", json.RawMessage(params), nil); err == nil {
			t.Fatalf("accepted %s", params)
		}
	}
	value, stream, err := h.Handle(context.Background(), "skills.inventory", json.RawMessage(`{"key":"hermes:writer"}`), nil)
	if err != nil || stream || value == nil {
		t.Fatalf("dispatch: %v", err)
	}
}

// A Hermes profile's inventory carries the agentpod-live plugin beside its
// skills when the plugin is there, and nothing when it is not.
func TestHermesInventoryReportsTheLivePluginWhenPresent(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "writer")
	if err := os.MkdirAll(filepath.Join(profile, "skills"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("plugins:\n  enabled:\n    - agentpod-live\n  stream_reasoning_deltas: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	provider := NewHermes(home).(descriptor.SkillInventoryProvider)
	result, err := provider.SkillInventory(context.Background(), "hermes:writer")
	if err != nil || len(result.Plugins) != 0 {
		t.Fatalf("a profile without the plugin reported %+v (%v)", result.Plugins, err)
	}
	for name, data := range hermeslive.Files() {
		target := filepath.Join(profile, "plugins", hermeslive.Name, name)
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	result, err = provider.SkillInventory(context.Background(), "hermes:writer")
	if err != nil || len(result.Plugins) != 1 {
		t.Fatalf("plugins = %+v (%v)", result.Plugins, err)
	}
	plugin := result.Plugins[0]
	if plugin.Name != hermeslive.Name || plugin.Scope != "profile" || plugin.Source.Kind != "plugin" ||
		plugin.Evidence.Present.Value == nil || !*plugin.Evidence.Present.Value ||
		plugin.Activation.Value == nil || !*plugin.Activation.Value {
		t.Fatalf("plugin = %+v", plugin)
	}
	if data, err := json.Marshal(result); err != nil || !strings.Contains(string(data), `"plugins":[{`) {
		t.Fatalf("inventory JSON lost the plugin: %v", err)
	}
}
