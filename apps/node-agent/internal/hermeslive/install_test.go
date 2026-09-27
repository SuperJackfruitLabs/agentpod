package hermeslive

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var allowed = Gate{Allowed: true, Version: "0.21.3", Reason: "fixture"}

func profile(t *testing.T, config string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "profiles", "fixture")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(config), 0o640); err != nil {
		t.Fatal(err)
	}
	return dir
}

func copyShipped(t *testing.T, dir string) {
	t.Helper()
	for name, data := range Files() {
		target := filepath.Join(pluginDir(dir), name)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func ok(t *testing.T) func(Plan, error) Plan {
	return func(plan Plan, err error) Plan {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return plan
	}
}

func mustApply(t *testing.T, plan Plan) {
	t.Helper()
	if err := Apply(plan, time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
}

func TestEnableThenDisableRestoresTheProfileExactly(t *testing.T) {
	original := "model: fixture\nplatforms:\n  - matrix\n"
	dir := profile(t, original)

	plan := ok(t)(PlanEnable(dir, allowed, false))
	if plan.FileAction != "add" || plan.NoOp {
		t.Fatalf("plan = %+v", plan)
	}
	mustApply(t, plan)
	files, err := diskFiles(pluginDir(dir))
	if err != nil || Digest(files) != Digest(Files()) {
		t.Fatalf("installed files differ from the shipped plugin: %v", err)
	}
	config, _ := os.ReadFile(filepath.Join(dir, "config.yaml"))
	if !strings.Contains(string(config), "- agentpod-live") || !strings.Contains(string(config), "stream_reasoning_deltas: true") {
		t.Fatalf("config not enabled:\n%s", config)
	}
	if info, _ := os.Stat(filepath.Join(dir, "config.yaml")); info.Mode().Perm() != 0o640 {
		t.Fatalf("config mode changed to %v", info.Mode().Perm())
	}

	// Enabling again is a no-op.
	again := ok(t)(PlanEnable(dir, allowed, false))
	if !again.NoOp {
		t.Fatalf("second enable is not a no-op: %+v", again)
	}

	// Python caches bytecode when Hermes loads the plugin; that must neither
	// block nor survive a disable.
	if err := os.MkdirAll(filepath.Join(pluginDir(dir), "__pycache__"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir(dir), "__pycache__", "__init__.cpython-311.pyc"), []byte("bytecode"), 0o644); err != nil {
		t.Fatal(err)
	}

	off := ok(t)(PlanDisable(dir))
	if !off.RestoresBackup || off.FileAction != "remove" {
		t.Fatalf("disable plan = %+v", off)
	}
	mustApply(t, off)
	restored, _ := os.ReadFile(filepath.Join(dir, "config.yaml"))
	if string(restored) != original {
		t.Fatalf("config not restored:\n%s", restored)
	}
	if _, err := os.Stat(pluginDir(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("plugin directory survived disable: %v", err)
	}
	if _, err := os.Stat(statePath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("install record survived disable: %v", err)
	}
	for _, made := range []string{filepath.Join(dir, "plugins"), filepath.Join(dir, stateDirName)} {
		if _, err := os.Stat(made); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("disable left the empty %s that enable made", made)
		}
	}
}

// strategy-sam: copied by hand, byte-identical, already enabled.
func TestEnableAdoptsAByteIdenticalManualInstall(t *testing.T) {
	config := "plugins:\n  enabled:\n    - agentpod-live\n  disabled: []\n  stream_reasoning_deltas: true\n_config_version: 45\n"
	dir := profile(t, config)
	copyShipped(t, dir)

	plan := ok(t)(PlanEnable(dir, allowed, false))
	if plan.FileAction != "adopt" || !bytes.Equal(plan.ConfigAfter, []byte(config)) {
		t.Fatalf("plan = %+v", plan)
	}
	mustApply(t, plan)
	if matches, _ := filepath.Glob(filepath.Join(dir, "config.yaml.bak-*")); len(matches) != 0 {
		t.Fatalf("an unchanged configuration was backed up: %v", matches)
	}

	off := ok(t)(PlanDisable(dir))
	mustApply(t, off)
	after, _ := os.ReadFile(filepath.Join(dir, "config.yaml"))
	want := "plugins:\n  enabled: []\n  disabled: []\n  stream_reasoning_deltas: true\n_config_version: 45\n"
	if string(after) != want {
		t.Fatalf("after disable:\n%s\nwant:\n%s", after, want)
	}
	if _, err := os.Stat(pluginDir(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("adopted plugin was not removed")
	}
}

func TestEnableRefusesADifferentManualCopyUnlessAskedToSetItAside(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	if err := os.MkdirAll(pluginDir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir(dir), "__init__.py"), []byte("# a hand-edited copy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := PlanEnable(dir, allowed, false); err == nil || !strings.Contains(err.Error(), "--replace-unmanaged") {
		t.Fatalf("err = %v", err)
	}
	plan := ok(t)(PlanEnable(dir, allowed, true))
	mustApply(t, plan)
	off := ok(t)(PlanDisable(dir))
	mustApply(t, off)
	restored, err := os.ReadFile(filepath.Join(pluginDir(dir), "__init__.py"))
	if err != nil || string(restored) != "# a hand-edited copy\n" {
		t.Fatalf("the set-aside copy was not restored: %q %v", restored, err)
	}
}

func TestEnableRefusesWhenTheVersionGateDoes(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	if _, err := PlanEnable(dir, Gate{Reason: "Hermes 0.30.0 is outside the tested range"}, false); err == nil || !strings.Contains(err.Error(), "outside the tested range") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(pluginDir(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a refused plan wrote files")
	}
}

func TestApplyRefusesAPlanTheProfileHasMovedPast(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	plan := ok(t)(PlanEnable(dir, allowed, false))
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("model: changed\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := Apply(plan, time.Now()); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(pluginDir(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a stale plan wrote files")
	}
}

func TestDisableLeavesFilesEditedSinceInstallAlone(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	mustApply(t, ok(t)(PlanEnable(dir, allowed, false)))
	if err := os.WriteFile(filepath.Join(pluginDir(dir), "__init__.py"), []byte("# edited on the host\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := PlanDisable(dir); err == nil || !strings.Contains(err.Error(), "changed after apn installed it") {
		t.Fatalf("err = %v", err)
	}
}

func TestDisableWithoutAnInstallRecordRefuses(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	copyShipped(t, dir)
	if _, err := PlanDisable(dir); err == nil || !strings.Contains(err.Error(), "no record") {
		t.Fatalf("err = %v", err)
	}
}
