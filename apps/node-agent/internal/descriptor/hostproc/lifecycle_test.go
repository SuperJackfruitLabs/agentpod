package hostproc

import (
	"fmt"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// --- stopProcess ---

// TestStopProcess_KillsSleepProcess verifies that stopProcess sends SIGTERM to
// a running sleep process and that the process exits within the grace period.
func TestStopProcess_KillsSleepProcess(t *testing.T) {
	t.Parallel()
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	pid := cmd.Process.Pid

	if err := StopProcess(pid, 3*time.Second); err != nil {
		// Still clean up.
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("stopProcess: %v", err)
	}

	// Signal 0: if process is gone this returns an error.
	if err := cmd.Process.Signal(syscall.Signal(0)); err == nil {
		_ = cmd.Process.Kill()
		t.Fatal("process still alive after stopProcess")
	}
	_ = cmd.Wait()
}

// --- Lifecycle interface via a test-only implementation ---

// testLifecycleImpl is a minimal Lifecycle implementation that wraps a real
// process PID for Stop and records whether Start was called.
type testLifecycleImpl struct {
	pid      int    // PID of the process to stop
	startCmd string // non-empty means Start "succeeds" (records invocation)
	started  bool
}

func (d *testLifecycleImpl) Stop(_ string) error {
	return StopProcess(d.pid, 3*time.Second)
}

func (d *testLifecycleImpl) Start(key string) error {
	if d.startCmd == "" {
		return fmt.Errorf("no start command configured for %q", key)
	}
	d.started = true
	return nil
}

func TestLifecycle_Stop_ExitsProcess(t *testing.T) {
	t.Parallel()
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = cmd.Wait() }()

	d := &testLifecycleImpl{pid: cmd.Process.Pid}
	if err := d.Stop("test"); err != nil {
		_ = cmd.Process.Kill()
		t.Fatalf("Stop: %v", err)
	}
	if err := cmd.Process.Signal(syscall.Signal(0)); err == nil {
		t.Fatal("process still alive after Stop")
	}
}

func TestLifecycle_Start_NoCommand_ReturnsError(t *testing.T) {
	d := &testLifecycleImpl{} // no startCmd
	if err := d.Start("test"); err == nil {
		t.Fatal("expected error from Start with no startCmd")
	}
}

func TestLifecycle_Restart_StopThenStart(t *testing.T) {
	t.Parallel()
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = cmd.Wait() }()

	d := &testLifecycleImpl{pid: cmd.Process.Pid, startCmd: "true"}

	// Restart = Stop then Start.
	if err := d.Stop("test"); err != nil {
		_ = cmd.Process.Kill()
		t.Fatalf("Stop in restart: %v", err)
	}
	if err := d.Start("test"); err != nil {
		t.Fatalf("Start in restart: %v", err)
	}
	if !d.started {
		t.Fatal("expected Start to be called during restart")
	}
}
