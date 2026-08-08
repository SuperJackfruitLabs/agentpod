// Package service manages the node-agent as a platform background service:
// a launchd LaunchAgent on macOS, a systemd unit on Linux. It is the shared
// implementation behind `apn service install/uninstall` and the
// start/stop/restart/status verbs, and behind selfupdate's service restart.
package service

import (
	"errors"
	"fmt"
	"os"
	"runtime"
)

// Runner executes a command and returns its combined stdout (trimmed) — the
// injectable seam for tests. nil means exec.Command for real.
type Runner func(name string, args ...string) (string, error)

// Status reports the current state of the installed service.
type Status struct {
	Installed bool   `json:"installed"`
	Enabled   bool   `json:"enabled"`
	Running   bool   `json:"running"`
	PID       int    `json:"pid"`
	UnitPath  string `json:"unitPath"` // plist/unit file location
}

// Manager controls the platform service lifecycle for the node-agent.
type Manager interface {
	Install() error   // write template, enable, start; idempotent
	Uninstall() error // stop, disable, remove file; idempotent
	Start() error     // enable + start
	Stop() error      // stop + disable (sticky)
	Restart() error
	Status() (Status, error)
}

// NewManager picks the platform implementation. darwin: launchd per-user
// (returns an error for uid 0 — macOS installs are per-user by policy).
// linux: systemd; user scope when uid != 0 OR the user unit answers
// `systemctl --user is-active agentpod-node` (preserves selfupdate's probe
// behavior), else system scope.
func NewManager(run Runner) (Manager, error) {
	return newManager(runtime.GOOS, os.Getuid(), run)
}

// newManager is the GOOS/uid-injectable core of NewManager, kept separate so
// the platform-selection branches are unit-testable without root privileges
// or a second OS.
func newManager(goos string, uid int, run Runner) (Manager, error) {
	switch goos {
	case "darwin":
		if uid == 0 {
			return nil, errors.New("macOS installs are per-user; run without sudo")
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("service: resolve home dir: %w", err)
		}
		return newLaunchdManager(home, uid, run), nil
	case "linux":
		// Task 2 adds systemdManager (user/system scope, mirroring
		// selfupdate.restartService's --user probe).
		return nil, errors.New("service: linux support not yet implemented")
	default:
		return nil, fmt.Errorf("service: unsupported platform %q", goos)
	}
}
