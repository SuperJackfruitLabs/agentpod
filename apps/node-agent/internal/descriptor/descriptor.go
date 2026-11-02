// Package descriptor defines the Descriptor interface and shared types for
// agent runtime harnesses, the Registry that holds them and the verb handler
// the hub calls. Each harness implements Descriptor in its own subpackage
// (internal/descriptor/hermes, …/openclaw, …/codex, …) and is registered with a
// Registry at startup (cmd/agentpod-node/registry.go). The subpackages share
// internal/descriptor/hostfs, hostproc, configdoc and acpskills, and import
// this package; it imports none of them.
package descriptor

import (
	"context"
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
	MatrixId *string `json:"matrixId"`
}

// Health is a point-in-time resource/liveness snapshot for a station.
type Health struct {
	ConfigurationDigest string   `json:"configurationDigest,omitempty"`
	Running             bool     `json:"running"`
	PID                 *int     `json:"pid"`
	CpuPct              *float64 `json:"cpuPct"`
	MemBytes            *int64   `json:"memBytes"`
	DiskBytes           *int64   `json:"diskBytes"`
	UptimeSec           *int64   `json:"uptimeSec"`
	LastActivity        *string  `json:"lastActivity"`
	Note                *string  `json:"note"`
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

// HealthForStation is an OPTIONAL interface a Descriptor may implement to
// report health for a station the caller has ALREADY detected.
//
// Health(key) must resolve key back to a workspace path, and for the workspace
// harnesses (claude-code, codex, opencode) that means re-running Detect — a
// full host re-scan that forks git once per project. A caller that sweeps
// every station, which is exactly what the health tick does, therefore pays
// O(N²) scans for N stations: 26 projects cost 702 git processes per tick.
// HealthFor takes the Station the caller already holds and reads its
// WorkspacePath directly, making the sweep O(N).
//
// Implementations MUST fall back to Health(s.Key) when s.WorkspacePath is nil.
type HealthForStation interface {
	HealthFor(s Station) (Health, error)
}

// HealthOf returns d's health snapshot for an already-detected station, taking
// the O(N) path when d implements HealthForStation and falling back to the
// key-resolving Health otherwise.
//
// Any caller sweeping many stations should use this rather than d.Health(s.Key)
// — see HealthForStation for what the difference costs.
func HealthOf(d Descriptor, s Station) (Health, error) {
	if hf, ok := d.(HealthForStation); ok {
		return hf.HealthFor(s)
	}
	return d.Health(s.Key)
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
