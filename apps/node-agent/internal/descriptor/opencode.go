package descriptor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// openCodeDescriptor implements Descriptor for the OpenCode leaf harness.
//
// OpenCode is a project-workspace harness with no persistent process: each
// project directory is a leaf station. The data-dir layout is:
//
//	~/.local/share/opencode/
//	  project/
//	    <sanitised-cwd>/  ← cwd with leading '/' stripped, then '/' → '-'
//	                         e.g. /Users/foo/bar → Users-foo-bar
//	    global/           ← special entry – ALWAYS skipped
//	  log/
//	    <timestamp>.log   ← global log files (not per-project)
//	  opencode.db         ← SQLite database; "project" table has "worktree" column
//	                         with the original absolute project path
//
// Key format: "opencode:<8-hex-char SHA256 prefix of the project path>"
//
// Project path discovery: opencode.db is the preferred source (table "project",
// column "worktree", skip row where id="global"). If the DB is absent or the
// sqlite3 binary is unavailable, Detect falls back to enumerating
// <dataDir>/project/ dirs and decoding the sanitised names. On hosts where the
// DB is permanently unreadable — provisioned opencode containers ship no
// sqlite3 on purpose — that fallback IS the normal path, so it is logged on
// change of condition only, never per detect cycle (see noteDBUnreadable).
//
// Decode ambiguity (fallback only): OpenCode sanitises project paths by
// stripping the leading '/' and replacing remaining '/' with '-'. When
// decoding back, all '-' become '/' and a '/' is prepended. Path components
// that contain '-' in their original names are decoded incorrectly (e.g.
// demo-creditcheck → demo/creditcheck). This is inherent to the sanitisation
// scheme; non-existent decoded paths are silently filtered out.
type openCodeDescriptor struct {
	dataDir string // absolute path to ~/.local/share/opencode

	// mu guards dbFailureReason. Detect runs on the periodic detect loop and
	// again on every capability call that resolves a key.
	mu sync.Mutex
	// dbFailureReason is the last reported reason opencode.db could not be
	// read, or "" when the DB last read fine (the initial state). It exists so
	// the fallback is logged on a *change* of condition rather than once per
	// detect cycle — see noteDBUnreadable.
	dbFailureReason string
}

// NewOpenCode returns a Descriptor for the OpenCode harness.
// dataDir is the path to the OpenCode data directory. If empty it defaults to
// $HOME/.local/share/opencode.
func NewOpenCode(dataDir string) Descriptor {
	if dataDir == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			userHome = "."
		}
		dataDir = filepath.Join(userHome, ".local", "share", "opencode")
	}
	return &openCodeDescriptor{dataDir: dataDir}
}

// Harness returns the harness identifier.
func (o *openCodeDescriptor) Harness() string { return "opencode" }

// openCodeProjectKey derives a stable station key from a project directory path.
// Uses the first 4 bytes (8 hex chars) of SHA256(path) for brevity.
func openCodeProjectKey(projPath string) string {
	h := sha256.Sum256([]byte(projPath))
	return fmt.Sprintf("opencode:%x", h[:4])
}

// sanitiseOpenCodePath converts a project directory path to the sanitised
// directory name OpenCode uses under <dataDir>/project/:
// strip leading '/', then '/' → '-'.
// Example: /Users/foo/bar → Users-foo-bar
func sanitiseOpenCodePath(p string) string {
	trimmed := strings.TrimPrefix(p, "/")
	return strings.ReplaceAll(trimmed, "/", "-")
}

// decodeOpenCodePath converts a sanitised OpenCode project dir name back to an
// absolute path by replacing '-' with '/' and prepending '/'.
//
// Caveat: path components whose original names contain '-' are decoded
// incorrectly because '-' is also used as the separator (e.g. a project at
// /srv/demo-api decodes to /srv/demo/api). This ambiguity is inherent to
// OpenCode's sanitisation scheme; the decoded path is used only for an
// existence check, so non-existent paths are silently filtered out.
func decodeOpenCodePath(name string) string {
	return "/" + strings.ReplaceAll(name, "-", "/")
}

// Detect discovers leaf stations for OpenCode.
//
// It first reads project paths from opencode.db via the sqlite3 CLI (exact
// paths, no decode ambiguity). If that fails (DB absent or sqlite3 unavailable)
// it falls back to enumerating <dataDir>/project/ and decoding sanitised names.
// The "global" entry is always skipped. Paths that no longer exist on disk are
// filtered out.
func (o *openCodeDescriptor) Detect() ([]Station, error) {
	projsDir := filepath.Join(o.dataDir, "project")
	if _, err := os.Stat(projsDir); os.IsNotExist(err) {
		return []Station{}, nil
	}

	paths, err := o.loadProjectPaths()
	if err != nil {
		return nil, err
	}

	caps := []string{"health", "logs", "fs.read", "fs.write", "terminal", "cleanup", "acp"}
	if openCodeSupervised() {
		// Only a provisioned opencode container (deploy/node-opencode-entrypoint.sh)
		// runs a supervised `opencode serve` process for Stop/Start to control.
		// On a real host, opencode has no persistent process to manage — the
		// capability, and therefore the descriptor's Lifecycle methods, must
		// stay unadvertised there.
		caps = append(caps, "lifecycle")
	}
	seen := make(map[string]bool)
	var stations []Station

	for _, projPath := range paths {
		if _, err := os.Stat(projPath); os.IsNotExist(err) {
			continue // project directory was deleted
		}
		// Deduplicate by resolved absolute workspace path so that multiple DB
		// rows pointing at the same directory (e.g. periscope-workspace) or a
		// DB-row/dir-fallback overlap never produce duplicate stations.
		resolved, err := filepath.EvalSymlinks(projPath)
		if err != nil {
			resolved = projPath
		}
		if seen[resolved] {
			continue
		}
		seen[resolved] = true

		key := openCodeProjectKey(projPath)
		wsCopy := projPath
		stations = append(stations, Station{
			Key:           key,
			Harness:       "opencode",
			Kind:          "leaf",
			DisplayName:   filepath.Base(projPath),
			ParentKey:     nil,
			WorkspacePath: &wsCopy,
			Capabilities:  AppendChangesetCap(caps, &wsCopy),
			MatrixId:      nil,
		})
	}

	if stations == nil {
		stations = []Station{}
	}
	return stations, nil
}

// loadProjectPaths returns project directory paths by querying opencode.db.
// Falls back to listing <dataDir>/project/* and decoding the sanitised names
// if the DB is absent or the sqlite3 binary is unavailable.
func (o *openCodeDescriptor) loadProjectPaths() ([]string, error) {
	dbPath := filepath.Join(o.dataDir, "opencode.db")

	paths, err := o.projectPathsFromDB(dbPath)
	if err == nil {
		o.noteDBReadable(dbPath)
		return paths, nil
	}

	o.noteDBUnreadable(dbPath, err)
	return o.projectPathsFromDirs()
}

// noteDBUnreadable logs that the descriptor is using the directory-enumeration
// fallback — but only when that is *news*: the first failure, or a failure
// whose reason differs from the one last reported.
//
// Detect runs every 10-60s, and on a host where the DB is permanently
// unreadable (deploy/Dockerfile.opencode deliberately ships no sqlite3, making
// directory enumeration the primary path there) the unchanged condition
// previously produced one line per cycle — 83% of a real node's log volume,
// which buried the gateway events an operator actually needs (#231).
//
// Suppression is per reason string, so a genuine transition (e.g. "db not
// found" → "sqlite3 not in PATH", observed changing on a live host within a
// minute) still logs.
func (o *openCodeDescriptor) noteDBUnreadable(dbPath string, cause error) {
	reason := cause.Error()

	o.mu.Lock()
	repeat := o.dbFailureReason == reason
	o.dbFailureReason = reason
	o.mu.Unlock()

	if repeat {
		return
	}
	log.Printf("opencode: could not read %s (%v); "+
		"falling back to project/ directory enumeration "+
		"(note: decoded paths may be ambiguous when project names contain '-'; "+
		"repeats of this same reason are suppressed)", dbPath, cause)
}

// noteDBReadable logs recovery — the DB became readable after a fallback — so
// the log never leaves an operator believing a node is still degraded. Silent
// when the DB was already readable, which is the steady-state case.
func (o *openCodeDescriptor) noteDBReadable(dbPath string) {
	o.mu.Lock()
	recovered := o.dbFailureReason != ""
	o.dbFailureReason = ""
	o.mu.Unlock()

	if !recovered {
		return
	}
	log.Printf("opencode: %s is readable again; resuming db-backed project discovery", dbPath)
}

// projectPathsFromDB reads project worktree paths from opencode.db via the
// sqlite3 CLI. Rows where id='global' (the special global workspace) are
// skipped. Returns an error if sqlite3 is unavailable or the DB cannot be read.
func (o *openCodeDescriptor) projectPathsFromDB(dbPath string) ([]string, error) {
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("opencode: db not found at %s", dbPath)
	}

	// Use the sqlite3 CLI to extract worktree paths.
	cmd := exec.Command("sqlite3", dbPath,
		"SELECT worktree FROM project WHERE id != 'global' AND worktree != ''")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("opencode: sqlite3 query failed: %w", err)
	}

	var paths []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "/" {
			continue
		}
		paths = append(paths, line)
	}
	return paths, nil
}

// projectPathsFromDirs lists <dataDir>/project/ and decodes each sanitised
// directory name back to an absolute path by prepending '/' and replacing '-'
// with '/'. The "global" entry is always skipped.
// This is a best-effort fallback; path components that contain '-' will be
// decoded incorrectly.
func (o *openCodeDescriptor) projectPathsFromDirs() ([]string, error) {
	projsDir := filepath.Join(o.dataDir, "project")
	entries, err := os.ReadDir(projsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("opencode: listing %s: %w", projsDir, err)
	}

	var paths []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if e.Name() == "global" {
			continue
		}
		decoded := decodeOpenCodePath(e.Name())
		paths = append(paths, decoded)
	}
	return paths, nil
}

// projectDirFor returns the per-project data directory for projPath:
// <dataDir>/project/<sanitised-path>.
func (o *openCodeDescriptor) projectDirFor(projPath string) string {
	return filepath.Join(o.dataDir, "project", sanitiseOpenCodePath(projPath))
}

// projectPathForKey resolves a station key back to its project directory path
// by re-running Detect and filtering by key.
func (o *openCodeDescriptor) projectPathForKey(key string) (string, error) {
	stations, err := o.Detect()
	if err != nil {
		return "", err
	}
	for _, s := range stations {
		if s.Key == key && s.WorkspacePath != nil {
			return *s.WorkspacePath, nil
		}
	}
	return "", fmt.Errorf("opencode: station not found: %q", key)
}

// ACPCommand implements ACPCommander. OpenCode serves an ACP session via
// `opencode acp`, run from the station's project workspace (the same path
// term.open resolves through the workspace resolver).
func (o *openCodeDescriptor) ACPCommand(key string) (argv []string, dir string, env []string, err error) {
	projPath, err := o.projectPathForKey(key)
	if err != nil {
		return nil, "", nil, err
	}
	return []string{"opencode", "acp"}, projPath, nil, nil
}

// Health returns a best-effort liveness/resource snapshot for a leaf station.
//
// Running is determined via pgrep -f opencode (best-effort; false if
// undeterminable). DiskBytes walks the project workspace. LastActivity
// reflects the newest mtime under <dataDir>/project/<sanitised>/.
func (o *openCodeDescriptor) Health(key string) (Health, error) {
	projPath, err := o.projectPathForKey(key)
	if err != nil {
		return Health{}, err
	}

	health := Health{}

	// Disk usage from the shared async cache — never walk on the request path.
	health.DiskBytes = diskUsage(projPath)

	// Best-effort: detect a running opencode process.
	running, note := openCodeProcessRunning()
	health.Running = running
	if note != "" {
		health.Note = &note
	}

	// LastActivity: newest mtime across all files in the per-project data dir.
	projDataDir := o.projectDirFor(projPath)
	if newest := newestMtime(projDataDir); !newest.IsZero() {
		s := newest.UTC().Format(time.RFC3339)
		health.LastActivity = &s
	}

	return health, nil
}

// openCodeProcessRunning checks for a running opencode process via pgrep.
// Returns false with a note when the check is unavailable.
//
// In supervised (provisioned-container) mode the pattern is the exact serve
// command line: the broad "opencode" pattern permanently matches unrelated
// argv substrings inside the container — docker-init's own cmdline carries
// the entrypoint path "/node-opencode-entrypoint.sh" — so health could never
// report stopped (live-fleet finding, 2026-08-09). On real hosts the broad
// pattern is kept: any opencode process (TUI, serve, run) counts as running.
func openCodeProcessRunning() (running bool, note string) {
	pattern := "opencode"
	if openCodeSupervised() {
		pattern = "opencode serve"
	}
	cmd := exec.Command("pgrep", "-f", pattern)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			// pgrep exit 1 = no match.
			return false, ""
		}
		return false, "process check unavailable (pgrep not found or failed)"
	}
	return strings.TrimSpace(string(out)) != "", ""
}

// --- Lifecycle (gated: AGENTPOD_OPENCODE_SUPERVISED=1) ---
//
// A provisioned opencode container (deploy/node-opencode-entrypoint.sh) runs
// `opencode serve` under a supervision loop: a shell while-loop that restarts
// the process on crash with a 2s backoff. That loop is what makes the
// container a living, dispatchable station — but it also means a bare SIGTERM
// from Stop would be undone within 2s. The two sides coordinate via a
// sentinel file, /var/run/opencode-serve.stop:
//
//   - Stop terminates the running `opencode serve` process, THEN touches the
//     sentinel. The entrypoint loop checks the sentinel before every respawn
//     and exits the loop when it is present, so the process actually stays
//     down.
//   - Start removes the sentinel and re-spawns `opencode serve` itself
//     (the entrypoint loop already exited, so it will not race the respawn).
//
// On a real host (env var unset) these methods are unreachable in practice:
// Detect() omits "lifecycle" from capabilities, so neither the console nor
// the lifecycle dispatcher (cmd/agentpod-node/run.go) ever calls them for an
// opencode key.

const (
	// openCodeSupervisedEnvVar gates the "lifecycle" capability and the
	// interpretation of Stop/Start below. Set by
	// deploy/node-opencode-entrypoint.sh in provisioned opencode containers.
	openCodeSupervisedEnvVar = "AGENTPOD_OPENCODE_SUPERVISED"

	// openCodeServePattern is the pgrep -f pattern matching the supervised
	// `opencode serve` process, mirroring the entrypoint's invocation.
	openCodeServePattern = "opencode.*serve"
)

// These are `var`, not `const`, purely so tests can point them at a temp
// directory instead of the real container paths below. Production code never
// reassigns them.
var (
	// openCodeServeLogPath is the log file the entrypoint's supervision loop
	// appends to; Start appends to the same file so log output survives a
	// lifecycle-triggered restart.
	openCodeServeLogPath = "/var/log/opencode-serve.log"

	// openCodeServeSentinelPath is the file Stop touches (and Start removes)
	// to signal the entrypoint's supervision loop to halt/resume.
	openCodeServeSentinelPath = "/var/run/opencode-serve.stop"

	// openCodeWorkspaceDir is the fixed workspace root for a provisioned
	// opencode container (see node-opencode-entrypoint.sh).
	openCodeWorkspaceDir = "/workspace"
)

// openCodeSupervised reports whether this runtime is a provisioned opencode
// container running the supervised `opencode serve` loop, as opposed to a
// bare-metal fleet host where opencode has no persistent process.
func openCodeSupervised() bool {
	return os.Getenv(openCodeSupervisedEnvVar) == "1"
}

// openCodeServePID returns the PID of the running `opencode serve` process
// (matched via openCodeServePattern), or an error if none is found.
func openCodeServePID() (int, error) {
	out, err := exec.Command("pgrep", "-f", openCodeServePattern).Output()
	if err != nil {
		return 0, fmt.Errorf("no running 'opencode serve' process found")
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) == 0 {
		return 0, fmt.Errorf("no running 'opencode serve' process found")
	}
	return strconv.Atoi(fields[0])
}

// touchOpenCodeStopSentinel creates (or refreshes) the sentinel file that
// tells the entrypoint's supervision loop to stop respawning `opencode serve`.
func touchOpenCodeStopSentinel() error {
	if err := os.MkdirAll(filepath.Dir(openCodeServeSentinelPath), 0o755); err != nil {
		return fmt.Errorf("mkdir sentinel dir: %w", err)
	}
	f, err := os.OpenFile(openCodeServeSentinelPath, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("touch sentinel %q: %w", openCodeServeSentinelPath, err)
	}
	return f.Close()
}

// startOpenCodeServeDetached spawns `opencode serve` rooted at the workspace,
// detached from the node-agent process, appending stdout/stderr to the same
// log file the entrypoint's supervision loop writes to.
func startOpenCodeServeDetached() error {
	logFile, err := os.OpenFile(openCodeServeLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open log %q: %w", openCodeServeLogPath, err)
	}
	defer logFile.Close()

	cmd := exec.Command("opencode", "serve")
	cmd.Dir = openCodeWorkspaceDir
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start opencode serve: %w", err)
	}
	// Reap in the background so an unexpectedly short-lived process does not
	// linger as a zombie under the node-agent.
	go func() { _ = cmd.Wait() }()
	return nil
}

// Stop implements Lifecycle. It terminates the supervised `opencode serve`
// process (TERM → grace → KILL via stopProcess) and then touches the stop
// sentinel so the entrypoint's supervision loop does not immediately
// resurrect it. See the package comment above for the coordination mechanism.
//
// Guarded by openCodeSupervised(): Detect() only advertises "lifecycle" when
// AGENTPOD_OPENCODE_SUPERVISED=1, but Go's structural typing means Stop/Start
// are still callable if a lifecycle verb ever reached this descriptor another
// way (a hub bug, a future direct WS caller). Without this guard, Stop on a
// real host would hunt for (and possibly kill) any process whose command line
// happens to match "opencode.*serve".
func (o *openCodeDescriptor) Stop(key string) error {
	if !openCodeSupervised() {
		return fmt.Errorf("opencode: stop %q: lifecycle requires supervised mode (%s=1)", key, openCodeSupervisedEnvVar)
	}
	pid, err := openCodeServePID()
	if err != nil {
		return fmt.Errorf("opencode: stop %q: %w", key, err)
	}
	if err := stopProcess(pid, LifecycleGracePeriod); err != nil {
		return fmt.Errorf("opencode: stop %q: %w", key, err)
	}
	if err := touchOpenCodeStopSentinel(); err != nil {
		return fmt.Errorf("opencode: stop %q: %w", key, err)
	}
	return nil
}

// Start implements Lifecycle. It removes the stop sentinel and re-spawns
// `opencode serve` detached in /workspace, appending to the shared log.
//
// Guarded by openCodeSupervised() for the same reason as Stop: without it,
// Start would spawn an unsupervised `opencode serve` on a bare-metal host
// that has no supervision loop to restart it on crash and no sentinel
// convention for a later Stop to coordinate with.
func (o *openCodeDescriptor) Start(key string) error {
	if !openCodeSupervised() {
		return fmt.Errorf("opencode: start %q: lifecycle requires supervised mode (%s=1)", key, openCodeSupervisedEnvVar)
	}
	if err := os.Remove(openCodeServeSentinelPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("opencode: start %q: clear sentinel: %w", key, err)
	}
	if err := startOpenCodeServeDetached(); err != nil {
		return fmt.Errorf("opencode: start %q: %w", key, err)
	}
	return nil
}

// ListDir lists the directory at rel within the project workspace.
// Paths that escape the workspace via ".." are rejected.
func (o *openCodeDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	projPath, err := o.projectPathForKey(key)
	if err != nil {
		return nil, err
	}

	target, err := safeJoin(projPath, rel)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, fmt.Errorf("opencode: ListDir %q: %w", target, err)
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

// ReadFile reads up to maxBytes from rel within the project workspace.
func (o *openCodeDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	projPath, err := o.projectPathForKey(key)
	if err != nil {
		return nil, "", false, err
	}

	target, err := safeJoin(projPath, rel)
	if err != nil {
		return nil, "", false, err
	}

	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}

	f, err := os.Open(target)
	if err != nil {
		return nil, "", false, fmt.Errorf("opencode: ReadFile %q: %w", target, err)
	}
	defer f.Close()

	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, "", false, fmt.Errorf("opencode: ReadFile read %q: %w", target, err)
	}

	truncated := int64(n) > maxBytes
	if truncated {
		n = int(maxBytes)
	}
	return buf[:n], "", truncated, nil
}

// TailLogs emits log files from <dataDir>/log/ (*.log files).
// If follow is true it polls for new content until ctx is done.
// If no log files are found, emits nothing and returns without error.
func (o *openCodeDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	// Validate the key resolves to a known station.
	if _, err := o.projectPathForKey(key); err != nil {
		return err
	}

	logDir := filepath.Join(o.dataDir, "log")
	collect := func() []string { return collectOpenCodeLogFiles(logDir) }
	logFiles := collect()

	if !follow {
		// One-shot: emit the last N lines of existing content.
		return emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit)
	}

	// Follow mode: wait for a log file to exist (a harness that hasn't
	// written logs yet must not close the stream immediately), then emit the
	// last N lines and poll for appends.
	logFiles = waitForLogFiles(ctx, collect)
	if err := emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit); err != nil {
		return err
	}

	offsets := make(map[string]int64, len(logFiles))
	for _, f := range logFiles {
		if info, err := os.Stat(f); err == nil {
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
			logFiles = collectOpenCodeLogFiles(logDir)
			for _, path := range logFiles {
				off := offsets[path]
				n, err := emitLogFileFrom(path, off, emit)
				if err != nil {
					continue
				}
				offsets[path] = off + n
			}
		}
	}
}

// CleanPlan returns the cleanable items for the OpenCode station.
// Cleanable: ".cache" and "tmp" subdirectories + *.log files at workspace root.
func (o *openCodeDescriptor) CleanPlan(key string) ([]CleanItem, error) {
	projPath, err := o.projectPathForKey(key)
	if err != nil {
		return nil, err
	}
	return cleanPlanCommon(projPath, []string{".cache", "tmp"})
}

// CleanApply removes selected cleanable paths from the OpenCode workspace.
func (o *openCodeDescriptor) CleanApply(key string, paths []string) (int64, error) {
	projPath, err := o.projectPathForKey(key)
	if err != nil {
		return 0, err
	}
	plan, err := o.CleanPlan(key)
	if err != nil {
		return 0, err
	}
	return cleanApplyCommon(projPath, paths, plan)
}

// collectOpenCodeLogFiles walks logDir and returns paths of all *.log files.
// Missing directories are silently skipped.
func collectOpenCodeLogFiles(logDir string) []string {
	var files []string
	_ = filepath.WalkDir(logDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && strings.ToLower(filepath.Ext(d.Name())) == ".log" {
			files = append(files, path)
		}
		return nil
	})
	return files
}
