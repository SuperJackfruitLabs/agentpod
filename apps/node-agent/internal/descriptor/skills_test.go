package descriptor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
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

func TestSkillInventoryUnsupportedDescriptorDoesNotFallbackToFiles(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})
	_, _, err := NewHandler(reg).Handle(context.Background(), "skills.inventory", json.RawMessage(`{"key":"fake:station"}`), nil)
	if err == nil {
		t.Fatal("unsupported descriptor accepted inventory")
	}
}
