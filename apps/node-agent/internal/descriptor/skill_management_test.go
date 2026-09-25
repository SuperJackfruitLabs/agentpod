package descriptor

import (
	"context"
	"slices"
	"testing"
)

type managedSkillDescriptor struct{ fakeDescriptor }

func (d *managedSkillDescriptor) ManagedSkillWorkspace(ctx context.Context, key string) (string, error) {
	return localManagedSkillWorkspace(ctx, d, key)
}

type nativeManagedSkillDescriptor struct{ managedSkillDescriptor }

func (d *nativeManagedSkillDescriptor) NativeSkillReadiness(context.Context, string) (NativeSkillReadiness, error) {
	return NativeSkillReadiness{Harness: d.Harness(), Reason: "fixture"}, nil
}

func TestManagedSkillCapabilityRequiresProviderAndConfiguredDelivery(t *testing.T) {
	workspace := t.TempDir()
	reg := NewRegistry()
	provider := &managedSkillDescriptor{fakeDescriptor{harness: "codex", stations: []Station{{Key: "codex:fixture", Harness: "codex", WorkspacePath: &workspace, Capabilities: []string{"health"}}}}}
	reg.Register(provider)
	if slices.Contains(reg.DetectAll()[0].Capabilities, "skills.manage") {
		t.Fatal("management advertised without handler")
	}
	if _, _, err := reg.ManagedSkillWorkspace(t.Context(), "codex:fixture"); err == nil {
		t.Fatal("disabled management resolved workspace")
	}
	reg.EnableSkillManagement()
	if !slices.Contains(reg.DetectAll()[0].Capabilities, "skills.manage") {
		t.Fatal("configured provider unavailable")
	}
	if slices.Contains(provider.stations[0].Capabilities, "skills.manage") {
		t.Fatal("registry mutated descriptor-owned capabilities")
	}
	path, harness, err := reg.ManagedSkillWorkspace(t.Context(), "codex:fixture")
	if err != nil || path != workspace || harness != "codex" {
		t.Fatalf("incorrect binding: %v", err)
	}
	for _, key := range []string{"codex", "codex:../other", "codex:missing"} {
		if _, _, err := reg.ManagedSkillWorkspace(t.Context(), key); err == nil {
			t.Fatalf("undetected key accepted: %s", key)
		}
	}
	reg.Register(&fakeDescriptor{harness: "codex", stations: provider.stations})
	if slices.Contains(reg.DetectAll()[0].Capabilities, "skills.manage") {
		t.Fatal("unsupported descriptor advertised management")
	}
	if _, _, err := reg.ManagedSkillWorkspace(t.Context(), "codex:fixture"); err == nil {
		t.Fatal("unsupported provider accepted")
	}
}

func TestNativeSkillCapabilityRequiresExplicitOperatorEnablementAndReadinessProvider(t *testing.T) {
	workspace := t.TempDir()
	reg := NewRegistry()
	provider := &nativeManagedSkillDescriptor{managedSkillDescriptor{fakeDescriptor{harness: "codex", stations: []Station{{Key: "codex:fixture", Harness: "codex", WorkspacePath: &workspace, Capabilities: []string{"health"}}}}}}
	reg.Register(provider)
	reg.EnableSkillManagement()
	if slices.Contains(reg.DetectAll()[0].Capabilities, "skills.native") {
		t.Fatal("native management advertised without explicit operator enablement")
	}
	reg.EnableNativeSkillManagement()
	if !slices.Contains(reg.DetectAll()[0].Capabilities, "skills.native") {
		t.Fatal("native management was not advertised for a readiness-capable provider")
	}
	reg.Register(&managedSkillDescriptor{fakeDescriptor{harness: "codex", stations: provider.stations}})
	if slices.Contains(reg.DetectAll()[0].Capabilities, "skills.native") {
		t.Fatal("native management advertised without a readiness provider")
	}
}

func TestPluginCapabilityIsHermesOnlyAndOperatorEnabled(t *testing.T) {
	workspace := t.TempDir()
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "hermes", stations: []Station{{Key: "hermes:fixture", Harness: "hermes", WorkspacePath: &workspace}}})
	reg.Register(&fakeDescriptor{harness: "codex", stations: []Station{{Key: "codex:fixture", Harness: "codex", WorkspacePath: &workspace}}})
	advertised := func() []string {
		var keys []string
		for _, s := range reg.DetectAll() {
			if slices.Contains(s.Capabilities, "plugins.manage") {
				keys = append(keys, s.Key)
			}
		}
		return keys
	}
	if got := advertised(); len(got) != 0 {
		t.Fatalf("plugin management advertised without operator enablement: %v", got)
	}
	if _, err := reg.PluginProfileDir(t.Context(), "hermes:fixture"); err == nil {
		t.Fatal("a profile resolved without operator enablement")
	}
	reg.EnablePluginManagement()
	if got := advertised(); len(got) != 1 || got[0] != "hermes:fixture" {
		t.Fatalf("plugin management advertised on %v", got)
	}
	if dir, err := reg.PluginProfileDir(t.Context(), "hermes:fixture"); err != nil || dir != workspace {
		t.Fatalf("profile = %q, %v", dir, err)
	}
	for _, key := range []string{"codex:fixture", "hermes:absent"} {
		if _, err := reg.PluginProfileDir(t.Context(), key); err == nil {
			t.Fatalf("%s resolved", key)
		}
	}
}
