package descriptor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
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
	provider, ok := d.(SkillInventoryProvider)
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
	reg := NewRegistry()
	reg.Register(d)
	h := NewHandler(reg)
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

func TestAllSkillInventoryDescriptorsImplementOptionalInterface(t *testing.T) {
	home := t.TempDir()
	for _, d := range []Descriptor{NewHermes(home), NewOpenClaw(home), NewCodex(home), NewClaudeCode(home), NewOpenCode(home), NewPi(home)} {
		if _, ok := d.(SkillInventoryProvider); !ok {
			t.Fatalf("%s lacks its advertised provider", d.Harness())
		}
	}
}

func TestCodexSkillInventoryUsesFreshIsolatedDiscoveryEvidence(t *testing.T) {
	home, project, _ := buildCodexFixture(t)
	skill := filepath.Join(project, ".agents", "skills", "sjl-fixture", "skills", "fixture")
	if err := os.MkdirAll(skill, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: fixture\ndescription: Fixture\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	unmanaged := filepath.Join(project, ".agents", "skills", "local")
	if err := os.MkdirAll(unmanaged, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unmanaged, "SKILL.md"), []byte("---\nname: local\ndescription: Local fixture\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	d := newTestCodex(t, home, false)
	root := t.TempDir()
	pkg := filepath.Join(root, "node_modules", "@agentclientprotocol", "codex-acp")
	entry := filepath.Join(pkg, "dist", "index.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkg, "package.json"), []byte(`{"name":"@agentclientprotocol/codex-acp","version":"1.12.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	engine := filepath.Join(pkg, "node_modules", "@openai", "codex", "package.json")
	if err := os.MkdirAll(filepath.Dir(engine), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engine, []byte(`{"name":"@openai/codex","version":"0.154.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(root, "codex-acp")
	if err := os.Symlink(entry, shim); err != nil {
		t.Fatal(err)
	}
	d.acpBinary = shim
	d.adapterRunning = func(string, string) (bool, string) { return false, "" }
	called := false
	d.nativeSkillDiscovery = func(ctx context.Context, adapter, workspace string) ([]string, error) {
		called = true
		if adapter != shim || workspace != project {
			t.Fatalf("unexpected discovery scope %q %q", adapter, workspace)
		}
		return []string{"sjl-fixture:fixture"}, nil
	}
	result, err := d.SkillInventory(context.Background(), codexKeyFor(project))
	if err != nil || !called || len(result.Skills) != 2 {
		t.Fatalf("result=%+v called=%v err=%v", result, called, err)
	}
	byName := map[string]skills.Entry{}
	for _, entry := range result.Skills {
		byName[entry.Name] = entry
	}
	loaded := byName["fixture"].Evidence.Loaded
	if loaded.Value == nil || !*loaded.Value || loaded.ObservedAt == nil || !strings.Contains(loaded.Reason, "fresh isolated ACP") {
		t.Fatalf("unexpected loading evidence: %+v", loaded)
	}
	if loaded = byName["local"].Evidence.Loaded; loaded.Value != nil || !strings.Contains(loaded.Reason, "no established command-name mapping") {
		t.Fatalf("unmanaged skill loading evidence: %+v", loaded)
	}
}

func TestSkillInventoryUnsupportedDescriptorDoesNotFallbackToFiles(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})
	_, _, err := NewHandler(reg).Handle(context.Background(), "skills.inventory", json.RawMessage(`{"key":"fake:station"}`), nil)
	if err == nil {
		t.Fatal("unsupported descriptor accepted inventory")
	}
}
