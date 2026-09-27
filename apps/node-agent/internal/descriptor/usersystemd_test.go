package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeSessionAwareSystemctl writes a fake "systemctl" that behaves like the
// real one under a root system service: `--user` calls fail unless
// XDG_RUNTIME_DIR names a user runtime dir. It logs each call with the
// environment it saw.
func writeSessionAwareSystemctl(t *testing.T, binDir string) string {
	t.Helper()
	logFile := filepath.Join(binDir, "systemctl.log")
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s xdg=%%s bus=%%s\n' "$*" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" >> %s
[ -n "$XDG_RUNTIME_DIR" ] || exit 1
exit 0
`, logFile)
	if err := os.WriteFile(filepath.Join(binDir, "systemctl"), []byte(script), 0o755); err != nil {
		t.Fatalf("write fake systemctl: %v", err)
	}
	return logFile
}

// fakeRuntimeBase points userRuntimeBase at a temp dir holding this uid's
// runtime dir and session bus, as /run/user/<uid> does on a systemd host.
func fakeRuntimeBase(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	dir := filepath.Join(base, fmt.Sprint(os.Getuid()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bus"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	prev := userRuntimeBase
	userRuntimeBase = base
	t.Cleanup(func() { userRuntimeBase = prev })
	return dir
}

// Regression (2026-09-26, guild): the node agent runs as a root system service
// with no XDG_RUNTIME_DIR, so `systemctl --user cat hermes-gateway-<p>` failed,
// the unit looked absent, and a restart killed the unit's process (which
// systemd respawned) then launched a second `gateway run --replace` beside it.
// The unit then crash-looped on "Gateway already running".
func TestHermesUnitFoundWithoutSessionEnvironment(t *testing.T) {
	bin := t.TempDir()
	logFile := writeSessionAwareSystemctl(t, bin)
	prependPath(t, bin)
	t.Setenv("XDG_RUNTIME_DIR", "")
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	dir := fakeRuntimeBase(t)

	if !hermesUnitKnown("hermes-gateway-analyst-echo.service") {
		t.Fatalf("unit not found; systemctl saw:\n%s", readLog(t, logFile))
	}
	got := readLog(t, logFile)
	if !strings.Contains(got, "xdg="+dir+" ") || !strings.Contains(got, "bus=unix:path="+filepath.Join(dir, "bus")) {
		t.Fatalf("systemctl --user ran without the user session environment:\n%s", got)
	}
}

func TestHermesStopAndStartUseTheUnitWithoutSessionEnvironment(t *testing.T) {
	bin := t.TempDir()
	logFile := writeSessionAwareSystemctl(t, bin)
	pgrepLog := writeFakePgrep(t, bin)
	prependPath(t, bin)
	t.Setenv("XDG_RUNTIME_DIR", "")
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	fakeRuntimeBase(t)

	h := &hermesDescriptor{home: t.TempDir()}
	if err := h.Stop("hermes:analyst-echo"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if err := h.Start("hermes:analyst-echo"); err != nil {
		t.Fatalf("start: %v", err)
	}
	got := readLog(t, logFile)
	for _, want := range []string{"--user stop hermes-gateway-analyst-echo.service", "--user start hermes-gateway-analyst-echo.service"} {
		if !strings.Contains(got, want) {
			t.Fatalf("want %q, systemctl saw:\n%s", want, got)
		}
	}
	if p := readLog(t, pgrepLog); p != "" {
		t.Fatalf("fell back to pgrep despite a known unit: %s", p)
	}
}

// A caller that already has a session environment keeps it.
func TestUserSystemctlKeepsAnExistingSessionEnvironment(t *testing.T) {
	bin := t.TempDir()
	logFile := writeSessionAwareSystemctl(t, bin)
	prependPath(t, bin)
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1234")
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/custom/bus")
	fakeRuntimeBase(t)

	_ = userSystemctl("cat", "x.service").Run()
	got := readLog(t, logFile)
	if !strings.Contains(got, "xdg=/run/user/1234 bus=unix:path=/custom/bus") {
		t.Fatalf("session environment overridden:\n%s", got)
	}
}
