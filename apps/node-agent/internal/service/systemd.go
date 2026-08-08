package service

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/template"
)

// systemdUnitName is the systemd unit name (both --user and system scope),
// unchanged from install.sh's linux blocks.
const systemdUnitName = "agentpod-node"

// systemUnitDirDefault is where the system-scope unit lives in production.
// systemdManager.systemUnitPath overrides this in tests (a temp dir), since
// tests must never write to the real /etc.
const systemUnitDirDefault = "/etc/systemd/system"

//go:embed templates/agentpod-node-user.service
var systemdUserUnitTemplate string

//go:embed templates/agentpod-node-system.service
var systemdSystemUnitTemplate string

// systemdManager drives a systemd unit, either a per-user unit
// (~/.config/systemd/user, `systemctl --user`) or a system-wide unit
// (/etc/systemd/system, plain `systemctl`, requires root). run, home, uid,
// and systemUnitPath are all injectable so tests never touch the real
// systemd or /etc.
type systemdManager struct {
	run       Runner
	userScope bool
	home      string
	uid       int
	binPath   func() (string, error)

	// systemUnitPath overrides the system-scope unit file location.
	// Empty means the production default (systemUnitDirDefault). Only
	// meaningful when userScope is false; tests set this to a temp dir.
	systemUnitPath string
}

// newSystemdManager builds the production systemdManager: a real
// exec.Command Runner (when run is nil) and binPath resolved via
// os.Executable + EvalSymlinks (handles the "apn" wrapper symlink).
func newSystemdManager(run Runner, userScope bool, home string, uid int) *systemdManager {
	if run == nil {
		run = execRunner
	}
	return &systemdManager{
		run:       run,
		userScope: userScope,
		home:      home,
		uid:       uid,
		binPath:   resolveBinPath,
	}
}

// userUnitActive probes whether a user-scoped systemd unit is active. This
// is exactly selfupdate.restartService's existing linux probe argv
// (`systemctl --user is-active agentpod-node`) — NewManager's scope
// selection mirrors it so both stay in sync.
func userUnitActive(run Runner) bool {
	_, err := run("systemctl", "--user", "is-active", systemdUnitName)
	return err == nil
}

// baseArgs is the systemctl flag prefix for this manager's scope: "--user"
// for a per-user unit, nothing for a system unit.
func (m *systemdManager) baseArgs() []string {
	if m.userScope {
		return []string{"--user"}
	}
	return nil
}

// systemctl runs `systemctl [--user] <args...>` through the injected
// Runner.
func (m *systemdManager) systemctl(args ...string) (string, error) {
	full := append(append([]string{}, m.baseArgs()...), args...)
	return m.run("systemctl", full...)
}

// unitPath is the unit file location: ~/.config/systemd/user/agentpod-node.service
// for user scope, /etc/systemd/system/agentpod-node.service (or
// systemUnitPath, when overridden) for system scope.
func (m *systemdManager) unitPath() string {
	if m.userScope {
		return filepath.Join(m.home, ".config", "systemd", "user", systemdUnitName+".service")
	}
	if m.systemUnitPath != "" {
		return m.systemUnitPath
	}
	return filepath.Join(systemUnitDirDefault, systemdUnitName+".service")
}

// renderUnit executes the embedded unit template (user or system, per
// scope) against the resolved binary path.
func (m *systemdManager) renderUnit() ([]byte, error) {
	bin, err := m.binPath()
	if err != nil {
		return nil, fmt.Errorf("service: resolve binary path: %w", err)
	}

	raw := systemdSystemUnitTemplate
	if m.userScope {
		raw = systemdUserUnitTemplate
	}

	tmpl, err := template.New(systemdUnitName + ".service").Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("service: parse unit template: %w", err)
	}

	var buf bytes.Buffer
	data := struct{ BinaryPath string }{BinaryPath: bin}
	if err := tmpl.Execute(&buf, data); err != nil {
		return nil, fmt.Errorf("service: render unit: %w", err)
	}
	return buf.Bytes(), nil
}

// Install writes the unit file, reloads the daemon, and enables + starts
// the unit. Idempotent: re-install overwrites the file and re-enables.
func (m *systemdManager) Install() error {
	unit, err := m.renderUnit()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(m.unitPath()), 0o755); err != nil {
		return fmt.Errorf("service: create unit dir: %w", err)
	}
	if err := os.WriteFile(m.unitPath(), unit, 0o644); err != nil {
		return fmt.Errorf("service: write unit: %w", err)
	}

	if _, err := m.systemctl("daemon-reload"); err != nil {
		return fmt.Errorf("service: daemon-reload: %w", err)
	}
	if _, err := m.systemctl("enable", "--now", systemdUnitName); err != nil {
		return fmt.Errorf("service: enable: %w", err)
	}
	return nil
}

// Uninstall disables + stops the unit (error ignored — it may already be
// stopped), removes the unit file, and reloads the daemon. Idempotent: a
// missing unit file is not an error.
func (m *systemdManager) Uninstall() error {
	_, _ = m.systemctl("disable", "--now", systemdUnitName)
	if err := os.Remove(m.unitPath()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("service: remove unit: %w", err)
	}
	if _, err := m.systemctl("daemon-reload"); err != nil {
		return fmt.Errorf("service: daemon-reload: %w", err)
	}
	return nil
}

// Start enables and starts the unit.
func (m *systemdManager) Start() error {
	if _, err := m.systemctl("enable", "--now", systemdUnitName); err != nil {
		return fmt.Errorf("service: start: %w", err)
	}
	return nil
}

// Stop stops the unit (error ignored — it may already be stopped) and
// disables it so it will not restart on next boot/login ("sticky" stop).
func (m *systemdManager) Stop() error {
	_, _ = m.systemctl("stop", systemdUnitName)
	if _, err := m.systemctl("disable", systemdUnitName); err != nil {
		return fmt.Errorf("service: disable: %w", err)
	}
	return nil
}

// Restart restarts the unit in place. This is also the delegate
// selfupdate.restartService uses on linux — the argv must stay exactly
// "systemctl [--user] restart agentpod-node" for the matching scope.
func (m *systemdManager) Restart() error {
	if _, err := m.systemctl("restart", systemdUnitName); err != nil {
		return fmt.Errorf("service: restart: %w", err)
	}
	return nil
}

// Status reports installed/enabled/running state by combining a unit-file
// existence check with three systemctl queries. None of the queries
// failing is fatal: systemctl exits non-zero for "disabled"/"inactive" but
// still prints that state to stdout, which is all Status inspects.
func (m *systemdManager) Status() (Status, error) {
	st := Status{UnitPath: m.unitPath()}

	if _, err := os.Stat(m.unitPath()); err == nil {
		st.Installed = true
	} else if !os.IsNotExist(err) {
		return Status{}, fmt.Errorf("service: stat unit: %w", err)
	}

	if out, _ := m.systemctl("is-enabled", systemdUnitName); strings.TrimSpace(out) == "enabled" {
		st.Enabled = true
	}

	if out, _ := m.systemctl("is-active", systemdUnitName); strings.TrimSpace(out) == "active" {
		st.Running = true
	}

	if out, _ := m.systemctl("show", "-p", "MainPID", "--value", systemdUnitName); out != "" {
		if pid, err := strconv.Atoi(strings.TrimSpace(out)); err == nil {
			st.PID = pid
		}
	}

	return st, nil
}
