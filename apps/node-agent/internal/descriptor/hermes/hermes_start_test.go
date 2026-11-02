package hermes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// TestHermesStart_NativeFallbackLaunchesGatewayRun verifies that on a
// process-tree (non-systemd) Hermes deployment with no configured startCmd,
// Start falls back to launching the profile the native way —
// `hermes -p <name> gateway run --replace` — instead of erroring.
//
// The `-p <name>` form matters: the launched process must match
// hermesPattern() so Health/Stop (which pgrep on the same pattern) recognise
// it. Before this fix, restart (= Stop then Start) killed the profile on root
// deployments and the failed Start left it down (the 502 + outage seen live).
func TestHermesStart_NativeFallbackLaunchesGatewayRun(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home) // no startCmd configured

	// Inject a stub `hermes` on PATH that records its args. PATH is set to ONLY
	// the stub dir so `systemd-run` is not found → Start takes the plain-detached
	// fallback and resolves `hermes` to our stub. (systemctl is likewise absent,
	// so hermesUnitKnown() is false and Start reaches the native fallback.)
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args.txt")
	writeRecorderStub(t, filepath.Join(dir, "hermes"), argsFile)
	t.Setenv("PATH", dir)

	lc, ok := d.(descriptor.Lifecycle)
	if !ok {
		t.Fatal("hermes descriptor must implement Lifecycle")
	}
	if err := lc.Start("hermes:coder-kai"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Start launches detached (Setsid) and does not Wait; poll for the stub args.
	var got string
	for i := 0; i < 100; i++ {
		if b, err := os.ReadFile(argsFile); err == nil && len(b) > 0 {
			got = strings.TrimSpace(string(b))
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	want := "-p coder-kai gateway run --replace"
	if got != want {
		t.Errorf("native start args:\n got %q\nwant %q", got, want)
	}
}

// TestHermesStart_UsesSystemdRunWhenAvailable verifies that when `systemd-run`
// exists, Start launches the profile through it (a transient systemd service in
// its OWN cgroup) rather than as a direct child. The node-agent unit runs with
// KillMode=control-group, so a direct child would be SIGKILLed when the
// node-agent restarts (e.g. self-update); systemd-run makes the profile survive.
func TestHermesStart_UsesSystemdRunWhenAvailable(t *testing.T) {
	home := testdataHermesHome(t)
	lc := NewHermes(home).(descriptor.Lifecycle)

	dir := t.TempDir()
	sysdArgs := filepath.Join(dir, "systemd-run.args")
	writeRecorderStub(t, filepath.Join(dir, "systemd-run"), sysdArgs)
	// Stub `hermes` too so the fix can resolve it to an absolute path (systemd-run
	// transient services do not inherit our PATH).
	writeRecorderStub(t, filepath.Join(dir, "hermes"), filepath.Join(dir, "hermes.args"))
	t.Setenv("PATH", dir) // only our stubs — no real systemd-run/hermes

	if err := lc.Start("hermes:coder-kai"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	got := waitForStubArgs(t, sysdArgs)
	if !strings.Contains(got, "--collect") {
		t.Errorf("systemd-run should be invoked with --collect; got %q", got)
	}
	if !strings.HasSuffix(got, "hermes -p coder-kai gateway run --replace") {
		t.Errorf("systemd-run should launch the native gateway command; got %q", got)
	}
}

// writeRecorderStub writes an executable stub at path that records its args
// (space-joined) to argsFile and exits 0.
func writeRecorderStub(t *testing.T, path, argsFile string) {
	t.Helper()
	script := "#!/bin/sh\nprintf '%s ' \"$@\" > " + argsFile + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub %s: %v", path, err)
	}
}

// waitForStubArgs polls argsFile (a stub launched detached) until it has content.
func waitForStubArgs(t *testing.T, argsFile string) string {
	t.Helper()
	for i := 0; i < 100; i++ {
		if b, err := os.ReadFile(argsFile); err == nil && len(b) > 0 {
			return strings.TrimSpace(string(b))
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("stub did not record args to %s", argsFile)
	return ""
}
