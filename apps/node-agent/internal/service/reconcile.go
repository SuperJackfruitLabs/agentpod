package service

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Legacy templates: the only historical renders of the agentpod-node unit, taken
// byte-for-byte from commit c15b444f (the last template before the otel.env
// EnvironmentFile line was added in #659). The pre-#199 install.sh user heredoc and
// the old deploy/agentpod-node.service are identical to these modulo the binary path.
// They are embedded without a header comment so they stay byte-exact.

//go:embed templates/legacy/agentpod-node-user.v1.service
var legacyUserUnitTemplateV1 string

//go:embed templates/legacy/agentpod-node-system.v1.service
var legacySystemUnitTemplateV1 string

// UnitState is the outcome of reconciling the installed unit file.
type UnitState string

const (
	UnitCurrent    UnitState = "current"
	UnitStale      UnitState = "stale"
	UnitReconciled UnitState = "reconciled"
	UnitDrifted    UnitState = "drifted"
	UnitError      UnitState = "error"
	UnitNA         UnitState = "n/a"
)

// ReconcileResult is the state plus a human-readable detail.
type ReconcileResult struct {
	State  UnitState
	Detail string
}

// ReconcileOptions parameterises ReconcileUnit.
type ReconcileOptions struct {
	UserScope  bool
	UnitPath   string // installed unit file
	MarkerPath string // loop-guard marker file
	Run        Runner // for `systemctl [--user] daemon-reload`
	DryRun     bool   // classify only: a reconcilable unit reports "stale"
}

// ReconcileDaemonUnit is the production wrapper: unit path from systemdManager.unitPath,
// marker in markerDir, real Runner.
func ReconcileDaemonUnit(userScope bool, home, markerDir string, dryRun bool) ReconcileResult {
	m := newSystemdManager(nil, userScope, home, os.Getuid())
	return ReconcileUnit(ReconcileOptions{
		UserScope:  userScope,
		UnitPath:   m.unitPath(),
		MarkerPath: filepath.Join(markerDir, "unit.sha256"),
		Run:        execRunner,
		DryRun:     dryRun,
	})
}

// ReconcileUnit re-renders the installed unit when, and only when, it equals a known
// agentpod-node template render (current or legacy). Anything else is left alone.
func ReconcileUnit(o ReconcileOptions) ReconcileResult {
	// A symlinked unit (e.g. `systemctl link`) would be replaced by the rename: leave it.
	if fi, err := os.Lstat(o.UnitPath); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return ReconcileResult{UnitDrifted, fmt.Sprintf("%s is a symlink; left in place", o.UnitPath)}
	}
	raw, err := os.ReadFile(o.UnitPath)
	if err != nil {
		return ReconcileResult{UnitError, fmt.Sprintf("read %s: %v", o.UnitPath, err)}
	}
	installed := string(raw)

	bin, ok := installedBinaryPath(installed)
	if !ok {
		return drifted()
	}

	curTpl, legTpl := systemdSystemUnitTemplate, legacySystemUnitTemplateV1
	if o.UserScope {
		curTpl, legTpl = systemdUserUnitTemplate, legacyUserUnitTemplateV1
	}
	current, err := renderUnitTemplate(curTpl, bin)
	if err != nil {
		return ReconcileResult{UnitError, err.Error()}
	}
	legacy, err := renderUnitTemplate(legTpl, bin)
	if err != nil {
		return ReconcileResult{UnitError, err.Error()}
	}

	norm := normalizeUnit(installed, o.UserScope)
	if norm == normalizeUnit(string(current), o.UserScope) {
		if !o.DryRun { // status stays read-only
			if err := os.Remove(o.MarkerPath); err != nil && !os.IsNotExist(err) {
				return ReconcileResult{UnitError, fmt.Sprintf("remove marker %s: %v", o.MarkerPath, err)}
			}
		}
		return ReconcileResult{State: UnitCurrent}
	}
	if norm != normalizeUnit(string(legacy), o.UserScope) {
		return drifted()
	}

	desired := desiredUnit(string(current), installed, o.UserScope)
	sum := sha256.Sum256([]byte(desired))
	hash := hex.EncodeToString(sum[:])
	if m, err := os.ReadFile(o.MarkerPath); err == nil && strings.TrimSpace(string(m)) == hash {
		return ReconcileResult{UnitError, fmt.Sprintf("a previous rewrite of %s did not take effect; not rewriting/restarting again", o.UnitPath)}
	}
	if o.DryRun {
		return ReconcileResult{UnitStale, "unit predates the current template"}
	}

	// Marker first: if it cannot be written the unit is untouched, and if the rewrite
	// later fails to take effect the marker is the durable evidence for the next run.
	if err := os.MkdirAll(filepath.Dir(o.MarkerPath), 0o700); err != nil {
		return ReconcileResult{UnitError, fmt.Sprintf("create marker dir: %v", err)}
	}
	if err := os.WriteFile(o.MarkerPath, []byte(hash+"\n"), 0o600); err != nil {
		return ReconcileResult{UnitError, fmt.Sprintf("write marker %s: %v", o.MarkerPath, err)}
	}
	if err := writeFileAtomic(o.UnitPath, []byte(desired), 0o644); err != nil {
		return ReconcileResult{UnitError, fmt.Sprintf("write %s: %v", o.UnitPath, err)}
	}

	run := o.Run
	if run == nil {
		run = execRunner
	}
	args := []string{"daemon-reload"}
	if o.UserScope {
		args = []string{"--user", "daemon-reload"}
	}
	if out, err := run("systemctl", args...); err != nil {
		// systemd still holds the old definition: put the original bytes back so disk
		// and daemon agree; the kept marker makes the next run a loop-guard error.
		if rerr := writeFileAtomic(o.UnitPath, raw, 0o644); rerr != nil {
			return ReconcileResult{UnitError, fmt.Sprintf("daemon-reload: %v %s; restore %s: %v", err, out, o.UnitPath, rerr)}
		}
		return ReconcileResult{UnitError, fmt.Sprintf("daemon-reload: %v %s", err, out)}
	}
	return ReconcileResult{State: UnitReconciled, Detail: "rewrote " + o.UnitPath}
}

func drifted() ReconcileResult {
	return ReconcileResult{UnitDrifted, "manual edits; left in place"}
}

// installedBinaryPath extracts <path> from the single `ExecStart=<path> run` line.
func installedBinaryPath(unit string) (string, bool) {
	var found []string
	for _, l := range strings.Split(unit, "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "ExecStart=") {
			found = append(found, strings.TrimSpace(l))
		}
	}
	if len(found) != 1 {
		return "", false
	}
	f := strings.Fields(strings.TrimPrefix(found[0], "ExecStart="))
	if len(f) != 2 || f[1] != "run" {
		return "", false
	}
	return f[0], true
}

// normalizeUnit trims trailing whitespace per line and trailing empty lines. System
// scope also drops User=/Group= lines: they are operator parameters, not drift.
func normalizeUnit(s string, userScope bool) string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimRight(l, " \t\r")
		if !userScope {
			t := strings.TrimSpace(l)
			if strings.HasPrefix(t, "User=") || strings.HasPrefix(t, "Group=") {
				continue
			}
		}
		out = append(out, l)
	}
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return strings.Join(out, "\n")
}

// desiredUnit is the current render; for system scope the template's User=root line is
// replaced by the installed unit's User=/Group= lines, in their original order.
func desiredUnit(current, installed string, userScope bool) string {
	if userScope {
		return current
	}
	var keep []string
	for _, l := range strings.Split(installed, "\n") {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "User=") || strings.HasPrefix(t, "Group=") {
			keep = append(keep, strings.TrimRight(l, " \t\r"))
		}
	}
	if len(keep) == 0 {
		return current
	}
	lines := strings.Split(current, "\n")
	var out []string
	replaced := false
	for _, l := range lines {
		if !replaced && strings.TrimSpace(l) == "User=root" {
			out = append(out, keep...)
			replaced = true
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, "\n")
}

// writeFileAtomic writes via a temp file in the same dir, fsyncs, and renames over path.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".agentpod-node.service.tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	cleanup := func() { _ = os.Remove(tmp) }
	if _, err := f.Write(data); err != nil {
		f.Close()
		cleanup()
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		cleanup()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		cleanup()
		return err
	}
	if err := f.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		cleanup()
		return err
	}
	return nil
}
