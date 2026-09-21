package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func nativeVersionStub(t *testing.T, name, version string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s\\n' '"+version+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOtherNativePreflightsRequireRecordedDiscoveryAndQuiescence(t *testing.T) {
	ctx := context.Background()
	t.Run("opencode", func(t *testing.T) {
		dataDir, workspace := buildOpenCodeFixture(t)
		binary := nativeVersionStub(t, "opencode", "1.18.15")
		t.Setenv("PATH", filepath.Dir(binary))
		d := NewOpenCode(dataDir).(*openCodeDescriptor)
		d.nativeProcessRunning = func() (bool, string) { return false, "" }
		d.nativeSkillDiscovery = func(context.Context, string, string) ([]string, error) { return []string{"sjl-fixture"}, nil }
		got, err := d.NativeSkillReadiness(ctx, openCodeProjectKey(workspace))
		if err != nil || !got.Ready || got.AdapterPath != binary || got.EngineVersion != "1.18.15" {
			t.Fatalf("preflight=%+v err=%v", got, err)
		}
		loaded, err := d.NativeSkillLoading(ctx, openCodeProjectKey(workspace), []string{"sjl-fixture"})
		if err != nil || loaded.Value == nil || !*loaded.Value || loaded.ObservedAt == nil {
			t.Fatalf("loading=%+v err=%v", loaded, err)
		}
		loaded, err = d.NativeSkillLoading(ctx, openCodeProjectKey(workspace), []string{"sjl-missing"})
		if err != nil || loaded.Value == nil || *loaded.Value {
			t.Fatalf("missing loading=%+v err=%v", loaded, err)
		}
		d.nativeProcessRunning = func() (bool, string) { return true, "" }
		got, err = d.NativeSkillReadiness(ctx, openCodeProjectKey(workspace))
		if err != nil || got.Ready || !strings.Contains(got.Reason, "active") {
			t.Fatalf("busy preflight=%+v err=%v", got, err)
		}
		d.nativeProcessRunning = func() (bool, string) { return false, "" }
		older := nativeVersionStub(t, "opencode", "1.18.14")
		t.Setenv("PATH", filepath.Dir(older))
		got, err = d.NativeSkillReadiness(ctx, openCodeProjectKey(workspace))
		if err != nil || got.Ready || !strings.Contains(got.Reason, "supported version") {
			t.Fatalf("unrecognized preflight=%+v err=%v", got, err)
		}
		if _, err := d.NativeSkillReadiness(ctx, "opencode:unknown"); err == nil {
			t.Fatal("unknown station accepted")
		}
	})
	t.Run("pi", func(t *testing.T) {
		dataDir, workspace := buildPiFixture(t)
		d := NewPi(dataDir).(*piDescriptor)
		engine := nativeVersionStub(t, "pi", "0.84.1")
		packageDir := filepath.Join(t.TempDir(), "pi-acp")
		if err := os.MkdirAll(filepath.Join(packageDir, "dist"), 0755); err != nil {
			t.Fatal(err)
		}
		adapter := filepath.Join(packageDir, "dist", "index.js")
		if err := os.WriteFile(adapter, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(packageDir, "package.json"), []byte(`{"name":"pi-acp","version":"0.0.33"}`), 0600); err != nil {
			t.Fatal(err)
		}
		d.getenv = func(key string) string {
			switch key {
			case piBinaryEnv:
				return engine
			case piACPBinaryEnv:
				return adapter
			default:
				return ""
			}
		}
		got, err := d.NativeSkillReadiness(ctx, piProjectKey(workspace))
		if err != nil || got.Ready || got.EngineVersion != "0.84.1" || got.AdapterVersion != "0.0.33" || !strings.Contains(got.Reason, "ACP skill-loading") {
			t.Fatalf("preflight=%+v err=%v", got, err)
		}
	})
	t.Run("openclaw", func(t *testing.T) {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, "workspace"), 0755); err != nil {
			t.Fatal(err)
		}
		binary := nativeVersionStub(t, "openclaw", "2026.2.12")
		d := NewOpenClawFrom(OpenClawConfig{Home: home}).(*openclawDescriptor)
		d.resolveBinary = func() (string, error) { return binary, nil }
		got, err := d.NativeSkillReadiness(ctx, "openclaw")
		if err != nil || got.Ready || got.EngineVersion != "2026.2.12" || !strings.Contains(got.Reason, "shared gateway") {
			t.Fatalf("preflight=%+v err=%v", got, err)
		}
		d.gatewayURL = "wss://example.invalid"
		got, err = d.NativeSkillReadiness(ctx, "openclaw")
		if err != nil || got.Ready || !strings.Contains(got.Reason, "remote OpenClaw gateway") {
			t.Fatalf("remote preflight=%+v err=%v", got, err)
		}
		if _, err := d.NativeSkillReadiness(ctx, "openclaw:missing"); err == nil {
			t.Fatal("undetected agent accepted")
		}
	})
}

// Run with AGENTPOD_OPENCODE_ACP_BINARY pointing at a reviewed OpenCode 1.18.15
// executable. This optional integration check uses a synthetic skill and a
// disposable workspace; it starts an ACP session but sends no model prompt.
func TestOpenCodeInstalledACPSkillDiscovery(t *testing.T) {
	binary := os.Getenv("AGENTPOD_OPENCODE_ACP_BINARY")
	if binary == "" {
		t.Skip("set AGENTPOD_OPENCODE_ACP_BINARY to run the installed-runtime probe")
	}
	if version := nativeExecutableVersion(t.Context(), binary); version != "1.18.15" {
		t.Fatalf("expected reviewed OpenCode 1.18.15, got %q", version)
	}
	workspace := t.TempDir()
	skillDir := filepath.Join(workspace, ".opencode", "skills", "sjl-fixture")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: sjl-fixture\ndescription: Synthetic discovery probe.\n---\nSynthetic test.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	names, err := openCodeACPDiscoverSkills(t.Context(), binary, workspace)
	if err != nil || !slices.Contains(names, "sjl-fixture") {
		t.Fatalf("fresh ACP discovery names=%q err=%v", names, err)
	}
	sibling := t.TempDir()
	names, err = openCodeACPDiscoverSkills(t.Context(), binary, sibling)
	if err != nil || slices.Contains(names, "sjl-fixture") {
		t.Fatalf("sibling ACP discovery names=%q err=%v", names, err)
	}
}
