package descriptor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// nativeLoadingCodex builds a Codex descriptor whose adapter and bundled
// engine are a recorded discovery pair, so NativeSkillReadiness reports Ready
// and the faked fresh-session probe is the only remaining variable.
func nativeLoadingCodex(t *testing.T, discovery func(context.Context, string, string, string) ([]string, error)) (*codexDescriptor, string) {
	t.Helper()
	home, project, _ := buildCodexFixture(t)
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
	d.nodeBinary = "/opt/agentpod/node/bin/node"
	d.nodeVersion = func(string) (string, error) { return "v22.14.0", nil }
	d.nativeSkillDiscovery = discovery
	return d, codexKeyFor(project)
}

// Outcome 1: the probe ran and the names are not advertised. This is the
// observation a removal needs, and the one a station could not produce before.
func TestCodexNativeLoadingReportsAbsentNamesAsNotLoaded(t *testing.T) {
	d, key := nativeLoadingCodex(t, func(context.Context, string, string, string) ([]string, error) {
		return []string{"unrelated"}, nil
	})
	loading, err := d.NativeSkillLoading(context.Background(), key, []string{"sjl-fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if loading.Value == nil || *loading.Value || loading.ObservedAt == nil {
		t.Fatalf("a completed probe over absent names is not a negative observation: %+v", loading)
	}
	if !strings.Contains(loading.Reason, "did not advertise sjl-fixture") {
		t.Fatalf("negative reason does not name the evidence: %q", loading.Reason)
	}
}

// Outcome 2: the probe ran and the names are advertised. The reason must not
// assume a placement exists, because an absent placement uses the same probe.
func TestCodexNativeLoadingReportsAdvertisedNamesAsLoaded(t *testing.T) {
	d, key := nativeLoadingCodex(t, func(context.Context, string, string, string) ([]string, error) {
		return []string{"sjl-fixture"}, nil
	})
	loading, err := d.NativeSkillLoading(context.Background(), key, []string{"sjl-fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if loading.Value == nil || !*loading.Value || loading.ObservedAt == nil {
		t.Fatalf("advertised names were not reported loaded: %+v", loading)
	}
	if strings.Contains(loading.Reason, "in this placement") {
		t.Fatalf("positive reason assumes a placement exists: %q", loading.Reason)
	}
}

// Outcome 3a: the probe failed or timed out. It must never become a negative.
func TestCodexNativeLoadingProbeFailureIsNeverANegative(t *testing.T) {
	for _, failure := range []error{
		fmt.Errorf("ACP discovery deadline exceeded: context deadline exceeded"),
		fmt.Errorf("ACP output closed before discovery completed"),
	} {
		d, key := nativeLoadingCodex(t, func(context.Context, string, string, string) ([]string, error) {
			return nil, failure
		})
		loading, err := d.NativeSkillLoading(context.Background(), key, []string{"sjl-fixture"})
		if err == nil {
			t.Fatalf("a failed probe was answered instead of raised: %+v", loading)
		}
		if loading.Value != nil || loading.ObservedAt != nil {
			t.Fatalf("a failed probe carried a loading verdict: %+v", loading)
		}
		if !strings.Contains(err.Error(), "could not establish discovery") {
			t.Fatalf("probe failure does not name the condition: %v", err)
		}
	}
}

// Outcome 3b: the runtime is not the recorded pair, so no probe may run. The
// gate is fail-closed and the answer is unknown, with the reason for it.
func TestCodexNativeLoadingUnreadyRuntimeDoesNotProbe(t *testing.T) {
	probed := false
	d, key := nativeLoadingCodex(t, func(context.Context, string, string, string) ([]string, error) {
		probed = true
		return []string{"sjl-fixture"}, nil
	})
	d.codexBinary = "/opt/custom/codex"
	loading, err := d.NativeSkillLoading(context.Background(), key, []string{"sjl-fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if probed {
		t.Fatal("an unready runtime still ran a fresh-session probe")
	}
	if loading.Value != nil || loading.ObservedAt != nil {
		t.Fatalf("an unready runtime produced a loading verdict: %+v", loading)
	}
	if !strings.Contains(loading.Reason, "CODEX_PATH") {
		t.Fatalf("unknown reason does not name the condition: %q", loading.Reason)
	}
}

// Outcome 3c: nothing to check. An empty name set is unknown, not a negative.
func TestCodexNativeLoadingWithoutNamesIsUnknown(t *testing.T) {
	probed := false
	d, key := nativeLoadingCodex(t, func(context.Context, string, string, string) ([]string, error) {
		probed = true
		return nil, nil
	})
	loading, err := d.NativeSkillLoading(context.Background(), key, nil)
	if err != nil {
		t.Fatal(err)
	}
	if probed {
		t.Fatal("an empty name set still ran a fresh-session probe")
	}
	if loading.Value != nil || loading.ObservedAt != nil || loading.Reason == "" {
		t.Fatalf("an empty name set produced a loading verdict: %+v", loading)
	}
}
