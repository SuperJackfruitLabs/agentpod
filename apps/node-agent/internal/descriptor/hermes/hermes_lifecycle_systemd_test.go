package hermes

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeFakeSystemctl writes an executable shell script named "systemctl" in
// tmpDir. The script records each invocation (joined args) to a log file.
// When unitKnown is true, `cat` subcommand calls exit 0 (unit file readable);
// when false, they exit 1 (unit file not found), matching real systemd behaviour.
// All other subcommands (stop, start, …) always exit 0.
func writeFakeSystemctl(t *testing.T, tmpDir string, unitKnown bool) string {
	t.Helper()
	logFile := filepath.Join(tmpDir, "systemctl.log")
	catExit := 0
	if !unitKnown {
		catExit = 1
	}
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %s
case "$*" in
  *cat*) exit %d ;;
  *) exit 0 ;;
esac
`, logFile, catExit)
	scriptPath := filepath.Join(tmpDir, "systemctl")
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("writeFakeSystemctl: %v", err)
	}
	return logFile
}

// prependPath prepends dir to PATH for the duration of the test.
func prependPath(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

// TestHermesUnitName verifies the unit-name mapping for various keys.
//
// Root key "hermes" → "hermes-gateway.service" (no per-profile suffix;
// used when the operator runs a single root Hermes instance without --profile).
// Profile key "hermes:<name>" → "hermes-gateway-<name>.service".
func TestHermesUnitName(t *testing.T) {
	cases := []struct {
		key  string
		want string
	}{
		{"hermes", "hermes-gateway.service"},
		{"hermes:analyst-echo", "hermes-gateway-analyst-echo.service"},
		{"hermes:my-profile", "hermes-gateway-my-profile.service"},
		{"hermes:coder-kai", "hermes-gateway-coder-kai.service"},
	}
	for _, tc := range cases {
		got := hermesUnitName(tc.key)
		if got != tc.want {
			t.Errorf("hermesUnitName(%q) = %q, want %q", tc.key, got, tc.want)
		}
	}
}

// TestHermesStop_KnownUnit_UsesSystemctl asserts that Stop("hermes:analyst-echo")
// invokes "systemctl --user stop hermes-gateway-analyst-echo.service" when the
// unit is present in the user session.
func TestHermesStop_KnownUnit_UsesSystemctl(t *testing.T) {
	tmpDir := t.TempDir()
	sysLog := writeFakeSystemctl(t, tmpDir, true /* unit known */)
	prependPath(t, tmpDir)

	h := &Descriptor{home: t.TempDir()}
	if err := h.Stop("hermes:analyst-echo"); err != nil {
		t.Fatalf("Stop with known unit: unexpected error: %v", err)
	}

	log := readLog(t, sysLog)
	if !strings.Contains(log, "--user stop hermes-gateway-analyst-echo.service") {
		t.Errorf("expected 'systemctl --user stop hermes-gateway-analyst-echo.service' in log, got:\n%s", log)
	}
	// Confirm the existence check (cat) was run before the stop.
	if !strings.Contains(log, "cat") {
		t.Errorf("expected 'cat' existence check in log, got:\n%s", log)
	}
}

// TestHermesStop_AbsentUnit_FallsBackToPgrep asserts that Stop falls back to
// the pgrep/SIGTERM path when the systemd unit is not found, and does NOT
// invoke "systemctl stop".
func TestHermesStop_AbsentUnit_FallsBackToPgrep(t *testing.T) {
	tmpDir := t.TempDir()
	sysLog := writeFakeSystemctl(t, tmpDir, false /* unit absent */)
	pgrepLog := writeFakePgrep(t, tmpDir)
	prependPath(t, tmpDir)

	h := &Descriptor{home: t.TempDir()}
	err := h.Stop("hermes:analyst-echo")
	// Stop must return an error: the unit is absent so we fall back to pgrep,
	// which finds no running process.
	if err == nil {
		t.Fatal("Stop with absent unit + no running process: expected error, got nil")
	}

	sysLogContent := readLog(t, sysLog)
	// The existence check (cat) IS called, but stop is NOT.
	if strings.Contains(sysLogContent, " stop ") {
		t.Errorf("systemctl stop should NOT be called when unit is absent; log:\n%s", sysLogContent)
	}

	pgrepContent := readLog(t, pgrepLog)
	if pgrepContent == "" {
		t.Error("expected pgrep to be invoked as fallback, but pgrep.log is empty")
	}
	if !strings.Contains(pgrepContent, "analyst-echo") {
		t.Errorf("pgrep fallback should include 'analyst-echo' in the pattern; log:\n%s", pgrepContent)
	}
}

// TestHermesStart_KnownUnit_UsesSystemctl asserts that Start("hermes:analyst-echo")
// invokes "systemctl --user start hermes-gateway-analyst-echo.service" when the
// unit is present in the user session (regardless of startCmd).
func TestHermesStart_KnownUnit_UsesSystemctl(t *testing.T) {
	tmpDir := t.TempDir()
	sysLog := writeFakeSystemctl(t, tmpDir, true /* unit known */)
	prependPath(t, tmpDir)

	h := &Descriptor{home: t.TempDir()} // no startCmd — unit path takes over
	if err := h.Start("hermes:analyst-echo"); err != nil {
		t.Fatalf("Start with known unit: unexpected error: %v", err)
	}

	log := readLog(t, sysLog)
	if !strings.Contains(log, "--user start hermes-gateway-analyst-echo.service") {
		t.Errorf("expected 'systemctl --user start hermes-gateway-analyst-echo.service' in log, got:\n%s", log)
	}
}

// TestHermesStart_AbsentUnit_FallsBackToStartCmd asserts that, when the systemd
// unit is absent, a configured startCmd is executed and takes precedence over
// the native `hermes ... gateway run` fallback.
func TestHermesStart_AbsentUnit_FallsBackToStartCmd(t *testing.T) {
	tmpDir := t.TempDir()
	writeFakeSystemctl(t, tmpDir, false /* unit absent */)
	prependPath(t, tmpDir)

	// With a startCmd configured, Start must run it (not the native fallback).
	marker := filepath.Join(tmpDir, "startcmd-ran")
	h := &Descriptor{home: t.TempDir(), startCmd: "touch " + marker}
	if err := h.Start("hermes:analyst-echo"); err != nil {
		t.Fatalf("Start with absent unit + startCmd: unexpected error: %v", err)
	}

	// startCmd runs detached (Setsid, not waited on); poll for the marker file.
	found := false
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(marker); err == nil {
			found = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !found {
		t.Error("expected the configured startCmd to run when the unit is absent")
	}
}
