// Package descriptor defines the Descriptor interface and shared types for
// agent runtime harnesses. Each harness (hermes, opencode, …) implements
// Descriptor and is registered with a Registry at startup.
package descriptor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"
)

// Station is a discovered agent runtime instance.
// JSON tags MUST match the wire contract exactly.
type Station struct {
	Key           string   `json:"key"`
	Harness       string   `json:"harness"`
	Kind          string   `json:"kind"`
	DisplayName   string   `json:"displayName"`
	ParentKey     *string  `json:"parentKey"`
	WorkspacePath *string  `json:"workspacePath"`
	Capabilities  []string `json:"capabilities"`
	// MatrixId is the agent's Matrix user ID (mxid), e.g. "@name:id.agentpod.dev".
	// It is nil when the agent has no Matrix identity or the config cannot be read.
	// SECURITY: the access_token is NEVER read or stored here.
	MatrixId      *string  `json:"matrixId"`
}

// Health is a point-in-time resource/liveness snapshot for a station.
type Health struct {
	Running      bool     `json:"running"`
	PID          *int     `json:"pid"`
	CpuPct       *float64 `json:"cpuPct"`
	MemBytes     *int64   `json:"memBytes"`
	DiskBytes    *int64   `json:"diskBytes"`
	UptimeSec    *int64   `json:"uptimeSec"`
	LastActivity *string  `json:"lastActivity"`
	Note         *string  `json:"note"`
}

// FsEntry is a single directory entry returned by ListDir.
type FsEntry struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	Type     string  `json:"type"` // "file" | "dir" | "symlink"
	Size     *int64  `json:"size"`
	Modified *string `json:"modified"`
}

// LifecycleGracePeriod is the time between SIGTERM and SIGKILL in Stop.
const LifecycleGracePeriod = 5 * time.Second

// Lifecycle is an OPTIONAL interface that a Descriptor may implement to support
// process lifecycle management. The "lifecycle" capability is advertised in
// Detect output ONLY when the descriptor implements this interface.
//
// Stop sends SIGTERM to the running process, escalates to SIGKILL after
// LifecycleGracePeriod if the process persists, and returns nil once gone.
// Start launches the station using a descriptor-configured start command;
// it returns a clear error if no start command is set.
// Restart is performed by the caller as Stop then Start.
type Lifecycle interface {
	Stop(key string) error
	Start(key string) error
}

// CleanItem is a single item returned by CleanPlan.
// Path is RELATIVE to the station's workspace root so the UI shows clean paths.
type CleanItem struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Kind string `json:"kind"` // "logs" | "cache" | "tmp"
}

// Cleaner is an OPTIONAL interface that a Descriptor may implement to support
// disk cleanup. The "cleanup" capability is advertised in Detect output ONLY
// when the descriptor implements this interface.
//
// CleanPlan returns candidate items (relative paths + sizes); the caller
// presents them for user selection.
//
// CleanApply receives the user-selected relative paths, validates each one
// (re-jail to workspace + intersect with the current plan set), removes the
// accepted ones, and returns the total bytes freed.  Paths that fail either
// check are silently skipped (never removed).
type Cleaner interface {
	CleanPlan(key string) ([]CleanItem, error)
	CleanApply(key string, paths []string) (int64, error)
}

// stopProcess sends SIGTERM to pid, polls up to grace for exit, then SIGKILLs.
// Returns nil once the process is gone or if it was already absent.
//
// When pid is a direct child of the calling process (e.g. in tests), we use
// Wait4(WNOHANG) to reap the zombie after SIGTERM so that subsequent
// kill(pid, 0) calls return ESRCH. For non-child processes (production use),
// we fall back to kill(0) which returns ESRCH once the process is gone.
func stopProcess(pid int, grace time.Duration) error {
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

// Descriptor is implemented by each agent harness plugin.
type Descriptor interface {
	// Harness returns the harness identifier (e.g. "hermes", "opencode").
	Harness() string

	// Detect discovers all running stations for this harness.
	Detect() ([]Station, error)

	// Health returns a live health snapshot for the named station.
	Health(key string) (Health, error)

	// ListDir lists the directory at path within the station's workspace.
	ListDir(key, path string) ([]FsEntry, error)

	// ReadFile reads up to maxBytes from path within the station's workspace.
	// It returns the raw content bytes, an encoding hint ("utf8" or "base64"),
	// whether the file was truncated, and any error.
	ReadFile(key, path string, maxBytes int64) (content []byte, encoding string, truncated bool, err error)

	// TailLogs streams log output for the station, calling emit for each chunk.
	// If follow is true the stream continues until ctx is cancelled.
	TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error
}

// ACPCommander is an OPTIONAL interface implemented by descriptors whose
// harness can serve an ACP (Agent Client Protocol) session over stdio. The
// "acp" capability is advertised in Detect output ONLY when the descriptor
// implements this interface.
//
// ACPCommand returns the command to spawn for a station key: argv is the full
// command line (argv[0] is the binary); dir is the working directory; env is
// extra environment appended to the inherited one (may be nil).
type ACPCommander interface {
	ACPCommand(key string) (argv []string, dir string, env []string, err error)
}
