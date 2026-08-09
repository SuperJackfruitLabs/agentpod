package descriptor

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// hermesDescriptor implements Descriptor for the Hermes agent harness.
// The Hermes home directory layout is:
//
//	~/.hermes/
//	  config.yaml
//	  auth.json
//	  sessions/
//	  kanban.db
//	  logs/          ← global log files
//	  profiles/
//	    <name>/      ← one workspace per profile
type hermesDescriptor struct {
	home     string // absolute path to the .hermes home directory
	startCmd string // optional; set by NewHermes; used by Start
}

// NewHermes returns a Descriptor for the Hermes harness.
// home is the path to the Hermes home directory (e.g. "~/.hermes").
// If home is empty it defaults to $HOME/.hermes.
// startCmd (optional) is the shell command used by Start to launch Hermes.
// Hermes always advertises the "lifecycle" capability; if startCmd is empty,
// Start returns a descriptive error.
func NewHermes(home string, startCmd ...string) Descriptor {
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			userHome = "."
		}
		home = filepath.Join(userHome, ".hermes")
	}
	var cmd string
	if len(startCmd) > 0 {
		cmd = startCmd[0]
	}
	return &hermesDescriptor{home: home, startCmd: cmd}
}

// Harness returns the harness identifier.
func (h *hermesDescriptor) Harness() string { return "hermes" }

// Detect discovers all Hermes stations. It returns empty (nil-safe) if the
// home directory does not exist.
func (h *hermesDescriptor) Detect() ([]Station, error) {
	if _, err := os.Stat(h.home); os.IsNotExist(err) {
		return []Station{}, nil
	}

	caps := []string{"health", "logs", "fs.read", "fs.write", "terminal", "lifecycle", "cleanup", "acp"}
	homeCopy := h.home

	stations := []Station{
		{
			Key:           "hermes",
			Harness:       "hermes",
			Kind:          "composite",
			DisplayName:   "Hermes",
			ParentKey:     nil,
			WorkspacePath: &homeCopy,
			Capabilities:  caps,
		},
	}

	profilesDir := filepath.Join(h.home, "profiles")
	entries, err := os.ReadDir(profilesDir)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("hermes: reading profiles dir: %w", err)
	}

	parentKey := "hermes"
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		key := "hermes:" + name
		wsPath := filepath.Join(profilesDir, name)
		wsCopy := wsPath
		profileDir := wsPath
		stations = append(stations, Station{
			Key:           key,
			Harness:       "hermes",
			Kind:          "composite",
			DisplayName:   name,
			ParentKey:     &parentKey,
			WorkspacePath: &wsCopy,
			Capabilities:  caps,
			MatrixId:      MatrixIDFromProfile(profileDir, "id.agentpod.dev"),
		})
	}

	return stations, nil
}

// workspaceFor maps a station key to its workspace root path.
func (h *hermesDescriptor) workspaceFor(key string) (string, error) {
	if key == "hermes" {
		return h.home, nil
	}
	if strings.HasPrefix(key, "hermes:") {
		name := strings.TrimPrefix(key, "hermes:")
		if name == "" {
			return "", fmt.Errorf("hermes: empty profile name in key %q", key)
		}
		return filepath.Join(h.home, "profiles", name), nil
	}
	return "", fmt.Errorf("hermes: unrecognized key %q", key)
}

// ACPCommand implements ACPCommander. Hermes serves an ACP session via
// `hermes -p <profile> acp --accept-hooks`, run from the profile's workspace.
// The profile is derived from the station key the same way workspaceFor and
// hermesNativeStartArgs parse it; for the root "hermes" key the profile
// selector is omitted (mirroring hermesNativeStartArgs) and dir is the home.
func (h *hermesDescriptor) ACPCommand(key string) (argv []string, dir string, env []string, err error) {
	dir, err = h.workspaceFor(key)
	if err != nil {
		return nil, "", nil, err
	}
	if key == "hermes" {
		return []string{"hermes", "acp", "--accept-hooks"}, dir, nil, nil
	}
	name := strings.TrimPrefix(key, "hermes:")
	return []string{"hermes", "-p", name, "acp", "--accept-hooks"}, dir, nil, nil
}

// Health returns a best-effort liveness/resource snapshot for a station.
func (h *hermesDescriptor) Health(key string) (Health, error) {
	workspace, err := h.workspaceFor(key)
	if err != nil {
		return Health{}, err
	}

	health := Health{}

	// Disk usage from the shared async cache — never walk on the request path.
	health.DiskBytes = diskUsage(workspace)

	// Best-effort process check via pgrep.
	health.Running, _ = hermesProcessRunning(key)

	// Live process metrics: best-effort — when the profile is running, resolve
	// its PID and gather CPU/memory/uptime. Hermes runs a separate process per
	// profile, so these are honest PER-AGENT numbers. Any failure leaves the
	// metric fields nil; Health() never fails on a ps hiccup.
	if health.Running {
		if pid, err := hermesPID(key); err == nil {
			health.PID = &pid
			health.CpuPct, health.MemBytes, health.UptimeSec = gatherPidMetrics(pid)
		}
	}

	return health, nil
}

// hermesUnitName returns the systemd user unit name for a Hermes station key.
//
// For profile keys ("hermes:<name>") the unit is "hermes-gateway-<name>.service",
// matching the naming convention used on the real fleet (e.g.
// "hermes-gateway-analyst-echo.service").
//
// For the root "hermes" key (no --profile flag) the unit is
// "hermes-gateway.service" — used when the operator runs a single Hermes
// instance without a named profile. If no such unit is configured the
// existence check will return false and the pgrep/SIGTERM path is taken.
func hermesUnitName(key string) string {
	if key == "hermes" {
		return "hermes-gateway.service"
	}
	profile := strings.TrimPrefix(key, "hermes:")
	return fmt.Sprintf("hermes-gateway-%s.service", profile)
}

// hermesUnitKnown reports whether the given systemd --user unit file exists.
// `systemctl --user cat <unit>` exits 0 iff the unit file can be read, and
// non-zero when absent or when systemctl/the user session is unavailable.
func hermesUnitKnown(unit string) bool {
	return exec.Command("systemctl", "--user", "cat", unit).Run() == nil
}

// hermesPattern returns the pgrep -f (ERE) pattern for a Hermes station key.
// It matches BOTH profile-gateway invocation forms:
//
//	hermes -p <name> gateway ...                       (direct binary, short flag)
//	... hermes_cli.main --profile <name> gateway ...   (supervisor respawn, long flag)
//
// The long form is used when the Hermes main gateway restarts a profile;
// matching only the short form reported such profiles as stopped while running.
func hermesPattern(key string) string {
	if key == "hermes" {
		return "hermes"
	}
	name := strings.TrimPrefix(key, "hermes:")
	return fmt.Sprintf("(-p|--profile)[ =]%s gateway", name)
}

// hermesPID returns the PID of the running Hermes process for key,
// or an error if no matching process is found.
func hermesPID(key string) (int, error) {
	out, err := exec.Command("pgrep", "-f", hermesPattern(key)).Output()
	if err != nil {
		return 0, fmt.Errorf("no hermes process for key %q", key)
	}
	lines := strings.Fields(strings.TrimSpace(string(out)))
	if len(lines) == 0 {
		return 0, fmt.Errorf("no hermes process for key %q", key)
	}
	return strconv.Atoi(lines[0])
}

// hermesProcessRunning checks the process table for a running Hermes process.
// For a profile key "hermes:<name>" it looks for "hermes -p <name> gateway".
// For the root key it looks for any "hermes" process.
// Returns false (not an error) when the check cannot be performed.
func hermesProcessRunning(key string) (bool, error) {
	cmd := exec.Command("pgrep", "-f", hermesPattern(key))
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() == 1 {
				return false, nil
			}
		}
		return false, nil
	}
	return true, nil
}

// Stop implements Lifecycle. It prefers "systemctl --user stop <unit>" when
// the unit is registered in the user session, falling back to the pgrep/SIGTERM
// path for installations that do not use systemd user units.
func (h *hermesDescriptor) Stop(key string) error {
	unit := hermesUnitName(key)
	if hermesUnitKnown(unit) {
		return exec.Command("systemctl", "--user", "stop", unit).Run()
	}
	// Fallback: locate the process via pgrep and send SIGTERM/SIGKILL.
	pid, err := hermesPID(key)
	if err != nil {
		return fmt.Errorf("hermes: stop %q: %w", key, err)
	}
	return stopProcess(pid, LifecycleGracePeriod)
}

// Start implements Lifecycle. It prefers "systemctl --user start <unit>" when
// the unit is registered in the user session. Otherwise it runs the configured
// start command in a new session (detached). If neither is available it returns
// a descriptive error.
//
// Configure the start command by passing it to NewHermes or by setting
// hermesStartCmd in the node config file.
func (h *hermesDescriptor) Start(key string) error {
	unit := hermesUnitName(key)
	if hermesUnitKnown(unit) {
		return exec.Command("systemctl", "--user", "start", unit).Run()
	}
	// An operator-configured start command takes precedence over the native
	// fallback (it can encode a site-specific launcher).
	if h.startCmd != "" {
		cmd := exec.Command("sh", "-c", h.startCmd)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		return cmd.Start()
	}
	// Native fallback: launch the profile gateway the way the Hermes supervisor
	// does — `hermes -p <name> gateway run --replace` — detached so it outlives
	// the node-agent. This covers process-tree (non-systemd, e.g. root) Hermes
	// deployments where no unit exists and no startCmd is configured; without it
	// a restart would Stop the profile and then fail to Start it. The `-p <name>`
	// form keeps the launched process matchable by hermesPattern(), which
	// Health/Stop rely on via pgrep.
	return startDetached("hermes", hermesNativeStartArgs(key)...)
}

// startDetached launches a background process that must OUTLIVE a node-agent
// restart. The node-agent's own systemd unit uses KillMode=control-group, so a
// plain child we fork lives in our cgroup and is SIGKILLed when the node-agent
// restarts (e.g. self-update). To escape that cgroup we launch via `systemd-run`,
// which starts the command as a transient systemd service in its own cgroup,
// reparented to PID 1. On hosts without systemd-run there is no cgroup-kill
// concern, so we fall back to a plain detached (Setsid) child.
//
// The target binary is resolved to an absolute path first: a systemd-run
// transient service does not inherit our PATH, so a bare name might not resolve.
func startDetached(name string, args ...string) error {
	if runner, err := exec.LookPath("systemd-run"); err == nil {
		bin := name
		if abs, lpErr := exec.LookPath(name); lpErr == nil {
			bin = abs
		}
		// --collect reaps the transient unit when it exits; --quiet suppresses the
		// "Running as unit: …" notice.
		runArgs := append([]string{"--collect", "--quiet", bin}, args...)
		return exec.Command(runner, runArgs...).Run()
	}
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reap the child in the background so a short-lived process does not linger
	// as a defunct (zombie) entry under the node-agent. The launched gateway is
	// normally long-lived, so Wait simply blocks harmlessly until it exits; if it
	// exits promptly (or in tests with a fast stub), this prevents a leaked
	// zombie — one whose comm can otherwise be matched by pgrep.
	go func() { _ = cmd.Wait() }()
	return nil
}

// hermesNativeStartArgs builds the argv (after the `hermes` binary) to launch a
// profile gateway natively. For the root key it omits the profile selector.
func hermesNativeStartArgs(key string) []string {
	if key == "hermes" {
		return []string{"gateway", "run", "--replace"}
	}
	name := strings.TrimPrefix(key, "hermes:")
	return []string{"-p", name, "gateway", "run", "--replace"}
}

// ListDir lists the directory at rel (relative to the station's workspace).
func (h *hermesDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	workspace, err := h.workspaceFor(key)
	if err != nil {
		return nil, err
	}

	target, err := safeJoin(workspace, rel)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, fmt.Errorf("hermes: ListDir %q: %w", target, err)
	}

	result := make([]FsEntry, 0, len(entries))
	for _, entry := range entries {
		fsEntry := FsEntry{
			Name: entry.Name(),
			Path: filepath.Join(rel, entry.Name()),
		}
		switch {
		case entry.Type()&fs.ModeSymlink != 0:
			fsEntry.Type = "symlink"
		case entry.IsDir():
			fsEntry.Type = "dir"
		default:
			fsEntry.Type = "file"
			info, err := entry.Info()
			if err == nil {
				sz := info.Size()
				fsEntry.Size = &sz
				mod := info.ModTime().UTC().Format(time.RFC3339)
				fsEntry.Modified = &mod
			}
		}
		result = append(result, fsEntry)
	}
	return result, nil
}

// defaultMaxBytes is the fallback cap when ReadFile is called with maxBytes == 0.
const defaultMaxBytes = 1 << 20 // 1 MiB

// ReadFile reads up to maxBytes from path within the station's workspace.
// It returns the raw bytes, encoding hint ("" means auto-detect in handler),
// whether the file was truncated, and any error.
func (h *hermesDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	workspace, err := h.workspaceFor(key)
	if err != nil {
		return nil, "", false, err
	}

	target, err := safeJoin(workspace, rel)
	if err != nil {
		return nil, "", false, err
	}

	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}

	f, err := os.Open(target)
	if err != nil {
		return nil, "", false, fmt.Errorf("hermes: ReadFile %q: %w", target, err)
	}
	defer f.Close()

	// Read up to maxBytes+1 so we can detect truncation.
	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, "", false, fmt.Errorf("hermes: ReadFile read %q: %w", target, err)
	}

	truncated := int64(n) > maxBytes
	if truncated {
		n = int(maxBytes)
	}

	return buf[:n], "", truncated, nil
}

// TailLogs emits existing log content and, if follow is true, polls for
// appends until ctx is cancelled.
//
// Log search order:
//  1. <home>/logs/ — always searched for any key.
//  2. <home>/profiles/<name>/ — searched for profile keys (profile may contain
//     its own log files).
//
// The Hermes CLI is preferred when on PATH, but the implementation falls back
// to direct file reads so fixture tests pass without the CLI installed.
func (h *hermesDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	// Determine which directories to search for log files.
	logDirs := []string{filepath.Join(h.home, "logs")}

	if strings.HasPrefix(key, "hermes:") {
		name := strings.TrimPrefix(key, "hermes:")
		profileDir := filepath.Join(h.home, "profiles", name)
		logDirs = append(logDirs, profileDir)
	}

	// Collect all log file paths from the log directories.
	logFiles := collectLogFiles(logDirs)

	if !follow {
		// One-shot: emit the last N lines of existing content.
		return emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit)
	}

	// Follow mode: emit the last N lines first, then poll for appends.
	if err := emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit); err != nil {
		return err
	}

	// Track offsets per file for incremental reads.
	offsets := make(map[string]int64, len(logFiles))
	for _, f := range logFiles {
		info, err := os.Stat(f)
		if err == nil {
			offsets[f] = info.Size()
		}
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			// Re-discover log files (new files may have appeared).
			logFiles = collectLogFiles(logDirs)
			for _, path := range logFiles {
				off := offsets[path]
				n, err := emitLogFileFrom(path, off, emit)
				if err != nil {
					// Best effort — skip unreadable files.
					continue
				}
				offsets[path] = off + n
			}
		}
	}
}

// collectLogFiles walks dirs and returns paths of all regular files found.
// Missing directories are silently skipped.
func collectLogFiles(dirs []string) []string {
	var files []string
	for _, dir := range dirs {
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if !d.IsDir() {
				files = append(files, path)
			}
			return nil
		})
	}
	return files
}

// emitLogFiles reads and emits each file's full content.
func emitLogFiles(paths []string, emit func([]byte) error) error {
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue // best effort
		}
		if len(data) == 0 {
			continue
		}
		if err := emit(data); err != nil {
			return err
		}
	}
	return nil
}

// CleanPlan returns the cleanable items for the Hermes station.
// Cleanable items: the "logs" subdirectory within the station workspace
// (if it exists), plus any *.log files directly in the workspace root.
// All Path values are relative to the station's workspace.
func (h *hermesDescriptor) CleanPlan(key string) ([]CleanItem, error) {
	workspace, err := h.workspaceFor(key)
	if err != nil {
		return nil, err
	}
	return cleanPlanCommon(workspace, []string{"logs"})
}

// CleanApply removes the requested paths from the Hermes station workspace.
// Each path is (a) re-jailed to the workspace and (b) verified against the
// current plan set. Paths that fail either check are silently skipped.
// Returns the total bytes removed.
func (h *hermesDescriptor) CleanApply(key string, paths []string) (int64, error) {
	workspace, err := h.workspaceFor(key)
	if err != nil {
		return 0, err
	}
	plan, err := h.CleanPlan(key)
	if err != nil {
		return 0, err
	}
	return cleanApplyCommon(workspace, paths, plan)
}

// emitLogFileFrom reads from offset and emits new bytes. Returns bytes read.
func emitLogFileFrom(path string, offset int64, emit func([]byte) error) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}

	data, err := io.ReadAll(f)
	if err != nil {
		return 0, err
	}
	if len(data) == 0 {
		return 0, nil
	}
	if err := emit(data); err != nil {
		return 0, err
	}
	return int64(len(data)), nil
}
