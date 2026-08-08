package service

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"text/template"
)

// launchdLabel is the launchd job label, unchanged from install.sh's
// install_launch_agent().
const launchdLabel = "dev.agentpod.node"

//go:embed templates/dev.agentpod.node.plist
var launchdPlistTemplate string

// pidLineRE matches launchctl print's `pid = 1234` line (any indentation).
var pidLineRE = regexp.MustCompile(`(?m)^\s*"?pid"?\s*=\s*(\d+)\s*$`)

// launchdManager drives a per-user launchd LaunchAgent (gui/<uid> domain).
// home, uid, run, and binPath are all injectable so tests never touch the
// real ~/Library or invoke launchctl.
type launchdManager struct {
	home    string
	uid     int
	run     Runner
	binPath func() (string, error)
}

// newLaunchdManager builds the production launchdManager: a real exec.Command
// Runner (when run is nil) and binPath resolved via os.Executable +
// EvalSymlinks (handles the "apn" wrapper symlink).
func newLaunchdManager(home string, uid int, run Runner) *launchdManager {
	if run == nil {
		run = execRunner
	}
	return &launchdManager{
		home:    home,
		uid:     uid,
		run:     run,
		binPath: resolveBinPath,
	}
}

func execRunner(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func resolveBinPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("service: resolve executable: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("service: eval symlinks: %w", err)
	}
	return resolved, nil
}

func (m *launchdManager) plistPath() string {
	return filepath.Join(m.home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func (m *launchdManager) logPath() string {
	return filepath.Join(m.home, "Library", "Logs", "agentpod-node.log")
}

// domain is the launchctl gui domain for this user, e.g. "gui/501".
func (m *launchdManager) domain() string {
	return fmt.Sprintf("gui/%d", m.uid)
}

// serviceTarget is the fully-qualified launchctl service specifier, e.g.
// "gui/501/dev.agentpod.node".
func (m *launchdManager) serviceTarget() string {
	return m.domain() + "/" + launchdLabel
}

// renderPlist executes the embedded plist template against the resolved
// binary path and log path.
func (m *launchdManager) renderPlist() ([]byte, error) {
	bin, err := m.binPath()
	if err != nil {
		return nil, fmt.Errorf("service: resolve binary path: %w", err)
	}

	tmpl, err := template.New("dev.agentpod.node.plist").Parse(launchdPlistTemplate)
	if err != nil {
		return nil, fmt.Errorf("service: parse plist template: %w", err)
	}

	var buf bytes.Buffer
	data := struct {
		BinaryPath string
		LogPath    string
	}{BinaryPath: bin, LogPath: m.logPath()}
	if err := tmpl.Execute(&buf, data); err != nil {
		return nil, fmt.Errorf("service: render plist: %w", err)
	}
	return buf.Bytes(), nil
}

// Install writes the plist, enables the job, and (re)bootstraps it into the
// gui/<uid> domain. Idempotent: a stale bootstrap is torn down first
// (bootout errors are ignored — there may be nothing loaded yet).
func (m *launchdManager) Install() error {
	plist, err := m.renderPlist()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(m.plistPath()), 0o755); err != nil {
		return fmt.Errorf("service: create LaunchAgents dir: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(m.logPath()), 0o755); err != nil {
		return fmt.Errorf("service: create Logs dir: %w", err)
	}
	if err := os.WriteFile(m.plistPath(), plist, 0o644); err != nil {
		return fmt.Errorf("service: write plist: %w", err)
	}

	if _, err := m.run("launchctl", "enable", m.serviceTarget()); err != nil {
		return fmt.Errorf("service: enable: %w", err)
	}
	_, _ = m.run("launchctl", "bootout", m.serviceTarget()) // best-effort: nothing may be loaded
	if _, err := m.run("launchctl", "bootstrap", m.domain(), m.plistPath()); err != nil {
		return fmt.Errorf("service: bootstrap: %w", err)
	}
	return nil
}

// Uninstall tears down any loaded job (error ignored — it may already be
// unloaded) and removes the plist. Idempotent: a missing plist is not an
// error.
func (m *launchdManager) Uninstall() error {
	_, _ = m.run("launchctl", "bootout", m.serviceTarget())
	if err := os.Remove(m.plistPath()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("service: remove plist: %w", err)
	}
	return nil
}

// Start enables and (re)bootstraps the job. If the job is already
// bootstrapped, bootstrap errors and Start falls back to kickstart -k, which
// starts an existing-but-stopped job.
func (m *launchdManager) Start() error {
	if _, err := m.run("launchctl", "enable", m.serviceTarget()); err != nil {
		return fmt.Errorf("service: enable: %w", err)
	}
	if _, err := m.run("launchctl", "bootstrap", m.domain(), m.plistPath()); err != nil {
		if _, err := m.run("launchctl", "kickstart", "-k", m.serviceTarget()); err != nil {
			return fmt.Errorf("service: start: %w", err)
		}
	}
	return nil
}

// Stop unloads the job (error ignored — it may already be stopped) and
// disables it so it will not restart on next login/boot ("sticky" stop).
func (m *launchdManager) Stop() error {
	_, _ = m.run("launchctl", "bootout", m.serviceTarget())
	if _, err := m.run("launchctl", "disable", m.serviceTarget()); err != nil {
		return fmt.Errorf("service: disable: %w", err)
	}
	return nil
}

// Restart kills and restarts the job in place. This is also the delegate
// selfupdate.restartService uses on darwin — the argv must stay exactly
// "launchctl kickstart -k gui/<uid>/dev.agentpod.node".
func (m *launchdManager) Restart() error {
	if _, err := m.run("launchctl", "kickstart", "-k", m.serviceTarget()); err != nil {
		return fmt.Errorf("service: restart: %w", err)
	}
	return nil
}

// Status reports installed/enabled/running state by combining a plist
// existence check with two launchctl queries. Neither query failing is
// treated as fatal: an erroring "print" simply means not running, an
// erroring "print-disabled" is treated as "no disabled entry found".
func (m *launchdManager) Status() (Status, error) {
	st := Status{UnitPath: m.plistPath()}

	if _, err := os.Stat(m.plistPath()); err == nil {
		st.Installed = true
	} else if !os.IsNotExist(err) {
		return Status{}, fmt.Errorf("service: stat plist: %w", err)
	}

	disabledOut, _ := m.run("launchctl", "print-disabled", m.domain())
	st.Enabled = !strings.Contains(disabledOut, fmt.Sprintf("%q => disabled", launchdLabel))

	if printOut, err := m.run("launchctl", "print", m.serviceTarget()); err == nil {
		if pid, ok := parsePID(printOut); ok {
			st.Running = true
			st.PID = pid
		}
	}

	return st, nil
}

// parsePID extracts the pid from a `launchctl print` block's "pid = N" line.
func parsePID(printOutput string) (int, bool) {
	m := pidLineRE.FindStringSubmatch(printOutput)
	if m == nil {
		return 0, false
	}
	pid, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	return pid, true
}
