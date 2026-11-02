package hostproc

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// claudeProcessRunning checks for a running claude process whose working
// directory is projPath. Returns false with a note when the check is
// unavailable (e.g. lsof not installed). This is always best-effort.
// parseLsofCwds parses `lsof -Fn -d cwd` field output (p<pid> / f<fd> /
// n<path> line groups) into pid→cwd.
func ParseLsofCwds(out []byte) map[int]string {
	cwds := map[int]string{}
	pid := 0
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
		case 'n':
			if pid != 0 {
				cwds[pid] = line[1:]
			}
		}
	}
	return cwds
}

// CwdWithinWorkspace reports whether cwd is the workspace itself or nested
// inside it (a session that cd'd into a subdirectory still counts). Both
// sides are symlink-resolved when possible — lsof reports resolved paths
// (e.g. /private/var on macOS for a /var workspace), so a literal compare
// would miss real matches.
func CwdWithinWorkspace(cwd, workspace string) bool {
	resolve := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return filepath.Clean(p)
	}
	cwd = resolve(cwd)
	workspace = resolve(workspace)
	return cwd == workspace || strings.HasPrefix(cwd, workspace+string(filepath.Separator))
}

// ProcessRunningInWorkspace reports whether a process whose name matches the
// pgrep pattern is running with its working directory inside projPath. Used by
// the workspace harnesses (claude-code, codex), which have no persistent
// process of their own to look up.
//
// Detection is cwd-based: `pgrep <pattern>` finds candidate pids by process
// name, then one lsof call resolves their cwds. Selecting by name inside lsof
// (-c claude) does NOT work — the claude CLI rewrites its process title to its
// version string (e.g. "2.1.222"), and lsof's `+d dir` does not match a process
// whose cwd is the directory anyway. lsof's exit code is ignored when it
// produced output: it exits 1 on benign per-file warnings even with valid
// matches (the old code read that as "stopped" while sessions were running).
func ProcessRunningInWorkspace(pgrepPattern, projPath string) (running bool, note string) {
	out, err := exec.CommandContext(context.Background(), "pgrep", pgrepPattern).Output()
	if err != nil {
		if exitErr := (*exec.ExitError)(nil); errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return false, "" // no matching processes at all
		}
		return false, "process check unavailable (pgrep not found or failed)"
	}
	pids := strings.Fields(strings.TrimSpace(string(out)))
	if len(pids) == 0 {
		return false, ""
	}

	lsofOut, err := exec.CommandContext(context.Background(), "lsof", "-a", "-p", strings.Join(pids, ","), "-d", "cwd", "-Fn").Output()
	if err != nil && len(lsofOut) == 0 {
		if exitErr := (*exec.ExitError)(nil); errors.As(err, &exitErr) {
			return false, "" // ran but matched nothing
		}
		return false, "process check unavailable (lsof not found or failed)"
	}
	for _, cwd := range ParseLsofCwds(lsofOut) {
		if CwdWithinWorkspace(cwd, projPath) {
			return true, ""
		}
	}
	return false, ""
}
