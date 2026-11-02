package harnesses

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/openclaw"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/opencode"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/pi"
)

func nativeVersionStub(t *testing.T, name, version string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s\\n' '"+version+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

// openclawReportStub is an OpenClaw that answers the two questions readiness
// and loading ask of it: its version, and its skill inventory.
func openclawReportStub(t *testing.T, version, report string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "openclaw")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = \"skills\" ]; then cat <<'REPORT'\n" + report + "\nREPORT\n  exit 0\nfi\n" +
		"printf '%s\\n' '" + version + "'\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
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
		d := opencode.NewOpenCode(dataDir).(*opencode.Descriptor)
		d.NativeProcessRunning = func() (bool, string) { return false, "" }
		d.NativeSkillDiscovery = func(context.Context, string, string) ([]string, error) { return []string{"sjl-fixture"}, nil }
		got, err := d.NativeSkillReadiness(ctx, opencode.OpenCodeProjectKey(workspace))
		if err != nil || !got.Ready || got.AdapterPath != binary || got.EngineVersion != "1.18.15" {
			t.Fatalf("preflight=%+v err=%v", got, err)
		}
		loaded, err := d.NativeSkillLoading(ctx, opencode.OpenCodeProjectKey(workspace), []string{"sjl-fixture"})
		if err != nil || loaded.Value == nil || !*loaded.Value || loaded.ObservedAt == nil {
			t.Fatalf("loading=%+v err=%v", loaded, err)
		}
		loaded, err = d.NativeSkillLoading(ctx, opencode.OpenCodeProjectKey(workspace), []string{"sjl-missing"})
		if err != nil || loaded.Value == nil || *loaded.Value {
			t.Fatalf("missing loading=%+v err=%v", loaded, err)
		}
		d.NativeProcessRunning = func() (bool, string) { return true, "" }
		got, err = d.NativeSkillReadiness(ctx, opencode.OpenCodeProjectKey(workspace))
		if err != nil || got.Ready || !strings.Contains(got.Reason, "active") {
			t.Fatalf("busy preflight=%+v err=%v", got, err)
		}
		d.NativeProcessRunning = func() (bool, string) { return false, "" }
		older := nativeVersionStub(t, "opencode", "1.18.14")
		t.Setenv("PATH", filepath.Dir(older))
		got, err = d.NativeSkillReadiness(ctx, opencode.OpenCodeProjectKey(workspace))
		if err != nil || got.Ready || !strings.Contains(got.Reason, "supported version") {
			t.Fatalf("unrecognized preflight=%+v err=%v", got, err)
		}
		if _, err := d.NativeSkillReadiness(ctx, "opencode:unknown"); err == nil {
			t.Fatal("unknown station accepted")
		}
	})
	t.Run("pi", func(t *testing.T) {
		dataDir, workspace := buildPiFixture(t)
		d := pi.NewPi(dataDir).(*pi.Descriptor)
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
		d.Getenv = func(key string) string {
			switch key {
			case pi.PiBinaryEnv:
				return engine
			case pi.PiACPBinaryEnv:
				return adapter
			default:
				return ""
			}
		}
		got, err := d.NativeSkillReadiness(ctx, pi.PiProjectKey(workspace))
		// This engine is the one whose fresh isolated session was observed
		// advertising skill:<id>, so readiness opens. It was asserted closed
		// while Pi had no such evidence; the assertion moves with it.
		if err != nil || !got.Ready || got.EngineVersion != "0.84.1" || got.AdapterVersion != "0.0.33" {
			t.Fatalf("preflight=%+v err=%v", got, err)
		}
		// An open gate must still name what it does not cover. Pi loads
		// project skills only for a run that trusts them, and that decision is
		// the operator's rather than a placement's.
		if !strings.Contains(got.Reason, "trust") {
			t.Fatalf("an open Pi gate does not mention project trust: %q", got.Reason)
		}
	})
	t.Run("openclaw", func(t *testing.T) {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, "workspace"), 0755); err != nil {
			t.Fatal(err)
		}
		// This gate was closed for every version on the stated grounds that
		// native publication "needs a gateway quiescence and ACP loading
		// gate". A probe against an installed 2026.2.12 refuted it: a fixture
		// written to <home>/skills/<name>/SKILL.md was reported ready by
		// `openclaw skills list --json` with no gateway running, and removing
		// it dropped the inventory back. The version gate and the REMOTE
		// gateway refusal both survive that; the blanket local one does not.
		binary := openclawReportStub(t, "2026.2.12", openclawSkillReport)
		d := openclaw.NewOpenClawFrom(openclaw.OpenClawConfig{Home: home}).(*openclaw.Descriptor)
		d.ResolveBinary = func() (string, error) { return binary, nil }
		got, err := d.NativeSkillReadiness(ctx, "openclaw")
		if err != nil || !got.Ready || got.EngineVersion != "2026.2.12" {
			t.Fatalf("preflight=%+v err=%v", got, err)
		}
		if strings.Contains(got.Reason, "quiescen") {
			t.Errorf("an open OpenClaw gate still claims a quiescence requirement: %q", got.Reason)
		}
		loaded, err := d.NativeSkillLoading(ctx, "openclaw", []string{"sjl-fixture"})
		if err != nil || loaded.Value == nil || !*loaded.Value || loaded.ObservedAt == nil {
			t.Fatalf("loading=%+v err=%v", loaded, err)
		}
		// The observation must not pass itself off as a session's account.
		if !strings.Contains(loaded.Reason, "harness's own report") {
			t.Errorf("OpenClaw loading does not say whose report it is: %q", loaded.Reason)
		}
		loaded, err = d.NativeSkillLoading(ctx, "openclaw", []string{"sjl-missing"})
		if err != nil || loaded.Value == nil || *loaded.Value {
			t.Fatalf("missing loading=%+v err=%v", loaded, err)
		}
		// Present-but-not-loadable is neither loaded nor absent: no value.
		for _, name := range []string{"muted", "blocked", "1password"} {
			loaded, err = d.NativeSkillLoading(ctx, "openclaw", []string{name})
			if err != nil || loaded.Value != nil {
				t.Errorf("%s should be indeterminate, got %+v err=%v", name, loaded, err)
			}
		}
		// A version nobody probed stays refused.
		older := openclawReportStub(t, "2026.1.1", openclawSkillReport)
		d.ResolveBinary = func() (string, error) { return older, nil }
		got, err = d.NativeSkillReadiness(ctx, "openclaw")
		if err != nil || got.Ready || !strings.Contains(got.Reason, "no recorded native skill discovery evidence") {
			t.Fatalf("unrecorded preflight=%+v err=%v", got, err)
		}
		// A configured REMOTE gateway is authoritative for its own inventory
		// and never falls back to client-local skills, so it stays refused.
		d.ResolveBinary = func() (string, error) { return binary, nil }
		d.GatewayURL = "wss://example.invalid"
		got, err = d.NativeSkillReadiness(ctx, "openclaw")
		if err != nil || got.Ready || !strings.Contains(got.Reason, "remote OpenClaw gateway") {
			t.Fatalf("remote preflight=%+v err=%v", got, err)
		}
		if _, err := d.NativeSkillReadiness(ctx, "openclaw:missing"); err == nil {
			t.Fatal("undetected agent accepted")
		}
	})
}
