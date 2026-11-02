package hostproc

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"
)

// StopProcess sends SIGTERM to pid, polls up to grace for exit, then SIGKILLs.
// Returns nil once the process is gone or if it was already absent.
//
// When pid is a direct child of the calling process (e.g. in tests), we use
// Wait4(WNOHANG) to reap the zombie after SIGTERM so that subsequent
// kill(pid, 0) calls return ESRCH. For non-child processes (production use),
// we fall back to kill(0) which returns ESRCH once the process is gone.
func StopProcess(pid int, grace time.Duration) error {
	// Safety: never signal pid<=1 — a 0/-1 pid would target the whole process
	// group (or every reachable process), and pid 1 is init.
	if pid <= 1 {
		return fmt.Errorf("stopProcess: refusing unsafe pid %d", pid)
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("find process %d: %w", pid, err)
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		if errors.Is(err, os.ErrProcessDone) || isNoSuchProcess(err) {
			return nil // already gone
		}
		return fmt.Errorf("SIGTERM pid %d: %w", pid, err)
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		// Try Wait4 with WNOHANG first: for direct children this reaps the
		// zombie and returns the PID once the child has exited.
		var ws syscall.WaitStatus
		if wpid, _ := syscall.Wait4(pid, &ws, syscall.WNOHANG, nil); wpid == pid {
			return nil // child reaped
		}
		// Fall back to kill(0) for non-child processes.
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			return nil // process exited or gone
		}
	}
	// Grace expired — escalate.
	_ = proc.Signal(syscall.SIGKILL)
	// Best-effort reap if it's a direct child.
	var ws syscall.WaitStatus
	syscall.Wait4(pid, &ws, 0, nil) //nolint:errcheck
	time.Sleep(100 * time.Millisecond)
	return nil
}

// isNoSuchProcess returns true if the error indicates ESRCH (no such process).
func isNoSuchProcess(err error) bool {
	return strings.Contains(err.Error(), "no such process") ||
		strings.Contains(err.Error(), "process already finished")
}
