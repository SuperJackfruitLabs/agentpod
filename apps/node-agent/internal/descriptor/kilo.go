package descriptor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// kiloDescriptor implements Descriptor for the Kilo leaf harness.
//
// Kilo is a project-workspace harness with no persistent process: each
// workspace it has been run in is a leaf station. The data-dir layout, observed
// on a live 7.8.8 install, is:
//
//	~/.local/share/kilo/
//	  kilo.db          ← SQLite. `project` has `worktree` (absolute path) and
//	                     `vcs`; `session` has `directory` (the session's cwd)
//	                     and `project_id`.
//	  log/
//	    <timestamp>.log ← global log files, not per-project
//	  repos/
//	  storage/
//
// Key format: "kilo:<8-hex-char SHA256 prefix of the workspace path>", the same
// scheme codex, claude-code, opencode and muse use.
//
// Kilo's CLI is opencode-derived in substance — the schema matches, and its log
// directory carries an `opencode.log` — so this descriptor is deliberately
// shaped like openCodeDescriptor. Where it differs is documented at
// kiloWorkspacesFromDB.
//
// Kilo speaks ACP natively (`kilo acp`), so there is no adapter to install,
// pin, or keep in step with the host.
type kiloDescriptor struct {
	dataDir string // absolute path to ~/.local/share/kilo

	// kiloBinary pins the CLI; empty means "resolve it".
	kiloBinary string

	// Host seams. These are fields so no test needs kilo or sqlite3 installed,
	// none touches the host's PATH or filesystem, and none spawns a
	// pgrep-visible child; production wiring in NewKiloFrom uses the real host.
	workspaces     func(dbPath string) ([]string, error)
	processRunning func(wsPath string) (running bool, note string)
	userHome       string                       // OS user home; "" omits home-relative candidates
	lookPath       func(string) (string, error) // exec.LookPath
	isExecutable   func(string) bool            // isExecutableFile
	getenv         func(string) string          // os.Getenv
}

// KiloConfig carries everything the descriptor needs. Zero values are valid: an
// unconfigured host still detects stations, and an ACP session still starts as
// long as `kilo` is reachable.
type KiloConfig struct {
	DataDir string // the kilo data dir; default $XDG_DATA_HOME/kilo, else <user home>/.local/share/kilo
	// Binary pins which kilo CLI serves ACP. Empty = resolve it.
	Binary string
}

// kiloBinaryName is the Kilo CLI. The npm package installs `kilo` and
// `kilocode`; `kilo` is the documented entry point and the one the ACP registry
// lists.
const kiloBinaryName = "kilo"

// NewKilo returns a Descriptor for the Kilo harness. dataDir is the kilo data
// directory; if empty it defaults to the XDG data location.
func NewKilo(dataDir string) Descriptor {
	return NewKiloFrom(KiloConfig{DataDir: dataDir})
}

// NewKiloFrom returns a Descriptor for the Kilo harness configured by cfg.
func NewKiloFrom(cfg KiloConfig) Descriptor {
	userHome, err := os.UserHomeDir()
	if err != nil {
		userHome = ""
	}
	dataDir := cfg.DataDir
	if dataDir == "" {
		dataDir = defaultKiloDataDir(userHome, os.Getenv)
	}
	return &kiloDescriptor{
		dataDir:        dataDir,
		kiloBinary:     cfg.Binary,
		workspaces:     kiloWorkspacesFromDB,
		processRunning: kiloProcessRunning,
		userHome:       userHome,
		lookPath:       exec.LookPath,
		isExecutable:   isExecutableFile,
		getenv:         os.Getenv,
	}
}

// defaultKiloDataDir resolves the data dir under $XDG_DATA_HOME when set,
// otherwise ~/.local/share — where a live install was observed to put it.
func defaultKiloDataDir(userHome string, getenv func(string) string) string {
	if xdg := getenv("XDG_DATA_HOME"); xdg != "" {
		return filepath.Join(xdg, "kilo")
	}
	base := userHome
	if base == "" {
		base = "."
	}
	return filepath.Join(base, ".local", "share", "kilo")
}

// Harness returns the harness identifier.
func (k *kiloDescriptor) Harness() string { return "kilo" }

// kiloWorkspaceKey derives a stable station key from a workspace path.
func kiloWorkspaceKey(wsPath string) string {
	h := sha256.Sum256([]byte(wsPath))
	return fmt.Sprintf("kilo:%x", h[:4])
}

// dbPath returns the path to kilo.db.
func (k *kiloDescriptor) dbPath() string {
	return filepath.Join(k.dataDir, "kilo.db")
}

func (k *kiloDescriptor) locator() binaryLocator {
	return binaryLocator{
		userHome:     k.userHome,
		lookPath:     k.lookPath,
		isExecutable: k.isExecutable,
	}
}

func (k *kiloDescriptor) kiloCLI() (string, bool) {
	return k.locator().locate(kiloBinaryName, k.kiloBinary)
}

// Detect discovers leaf stations, one per workspace Kilo has been run in.
//
// A missing data dir is not an error — it means Kilo has never run here. A
// database that exists but cannot be read IS an error: a host with Kilo
// installed and no sqlite3 would otherwise report no stations and no reason.
func (k *kiloDescriptor) Detect() ([]Station, error) {
	if _, err := os.Stat(k.dataDir); err != nil {
		if os.IsNotExist(err) {
			return []Station{}, nil
		}
		return nil, fmt.Errorf("kilo: reading %s: %w", k.dataDir, err)
	}

	paths, err := k.workspaces(k.dbPath())
	if err != nil {
		return nil, err
	}

	// "acp" is advertised only when the CLI that serves it resolves. Kilo needs
	// no adapter — `kilo acp` is native — so this is the whole chain, but it is
	// still checked rather than assumed: the console gates the Chat tab on this
	// capability alone, and a tab that fails on click is worse than no tab
	// (the 2026-08-12 Pi lesson).
	caps := []string{"skills.inventory", "health", "logs", "fs.read", "fs.write", "terminal", "cleanup"}
	if _, ok := k.kiloCLI(); ok {
		caps = append(caps, "acp")
	}

	stations := []Station{}
	seen := map[string]bool{}
	for _, wsPath := range paths {
		// A relative path cannot be a workspace root: it would resolve against
		// the SERVICE's cwd, and that resolution becomes the fs.read root and
		// the CleanApply root.
		if !filepath.IsAbs(wsPath) || wsPath == "/" {
			continue
		}
		if seen[wsPath] {
			continue
		}
		// Only "it is gone" drops a station; a transient stat failure must not
		// make one blink out of the fleet view.
		if _, err := os.Stat(wsPath); os.IsNotExist(err) {
			continue
		}
		seen[wsPath] = true
		wsCopy := wsPath
		stations = append(stations, Station{
			Key:           kiloWorkspaceKey(wsPath),
			Harness:       "kilo",
			Kind:          "leaf",
			DisplayName:   filepath.Base(wsPath),
			ParentKey:     nil,
			WorkspacePath: &wsCopy,
			Capabilities:  AppendChangesetCap(caps, &wsCopy),
		})
	}
	return stations, nil
}

// kiloWorkspacesFromDB reads workspace paths out of kilo.db via the sqlite3
// CLI, as the opencode descriptor reads its own database — a SQLite driver for
// two columns is not a trade worth making.
//
// TWO sources, unioned, which is where this departs from opencode:
//
//	project.worktree  — set when the workspace is a VCS checkout (`vcs` = git).
//	session.directory — the session's own cwd.
//
// Measured on a live 7.8.8 host: a session started in a NON-git directory
// leaves `project` holding only the special `global` row (worktree "/") and
// records the real path on `session.directory` alone. Reading `project` alone —
// the query opencode uses — returns nothing for that host, so a workspace an
// operator is actively working in would never become a station. Both are read
// and the union deduplicated in Detect.
//
// An absent database means Kilo has not recorded anything yet, which is not a
// failure.
func kiloWorkspacesFromDB(dbPath string) ([]string, error) {
	if _, err := os.Stat(dbPath); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("kilo: reading %s: %w", dbPath, err)
	}

	const query = `SELECT worktree FROM project WHERE id != 'global' AND worktree != '' AND worktree IS NOT NULL;` +
		`SELECT DISTINCT directory FROM session WHERE directory != '' AND directory IS NOT NULL;`

	out, err := exec.Command("sqlite3", "-readonly", dbPath, query).Output()
	if err != nil {
		return nil, fmt.Errorf("kilo: reading %s failed (is sqlite3 installed?): %w", dbPath, err)
	}

	var paths []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line != "" && line != "/" {
			paths = append(paths, line)
		}
	}
	return paths, nil
}

// workspacePathForKey resolves a station key back to its workspace path.
func (k *kiloDescriptor) workspacePathForKey(key string) (string, error) {
	stations, err := k.Detect()
	if err != nil {
		return "", err
	}
	for _, s := range stations {
		if s.Key == key && s.WorkspacePath != nil {
			return *s.WorkspacePath, nil
		}
	}
	return "", fmt.Errorf("kilo: station not found: %q", key)
}

// ACPCommand runs `kilo acp` in the station's workspace. Native ACP: nothing to
// install beside the CLI, and no adapter version to keep in step with it.
func (k *kiloDescriptor) ACPCommand(key string) ([]string, string, []string, error) {
	wsPath, err := k.workspacePathForKey(key)
	if err != nil {
		return nil, "", nil, err
	}
	binary, ok := k.kiloCLI()
	if !ok {
		return nil, "", nil, fmt.Errorf(
			"kilo: the %s CLI was not found; install it (npm i -g @kilocode/cli) or set its path in the node's kilo configuration",
			kiloBinaryName)
	}
	return []string{binary, "acp"}, wsPath, nil, nil
}

// Health reports on a station by key.
func (k *kiloDescriptor) Health(key string) (Health, error) {
	wsPath, err := k.workspacePathForKey(key)
	if err != nil {
		return Health{}, err
	}
	return k.healthAt(wsPath), nil
}

// HealthFor implements HealthForStation: it reads the workspace off the station
// the caller already detected, which turns a health sweep from O(N²) host scans
// into O(N).
func (k *kiloDescriptor) HealthFor(s Station) (Health, error) {
	if s.WorkspacePath == nil || *s.WorkspacePath == "" {
		return k.Health(s.Key)
	}
	return k.healthAt(*s.WorkspacePath), nil
}

func (k *kiloDescriptor) healthAt(wsPath string) Health {
	health := Health{}
	// Disk usage from the shared async cache — never walk on the request path.
	health.DiskBytes = diskUsage(wsPath)
	running, note := k.processRunning(wsPath)
	health.Running = running
	if note != "" {
		health.Note = &note
	}
	return health
}

// kiloProcessRunning reports whether a kilo process is running with its working
// directory inside wsPath. Always best-effort — see processRunningInWorkspace.
func kiloProcessRunning(wsPath string) (running bool, note string) {
	return processRunningInWorkspace("^kilo", wsPath)
}

// ListDir lists the directory at rel within the station's workspace.
func (k *kiloDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	wsPath, err := k.workspacePathForKey(key)
	if err != nil {
		return nil, err
	}
	target, err := safeJoin(wsPath, rel)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, fmt.Errorf("kilo: ListDir %q: %w", target, err)
	}

	result := make([]FsEntry, 0, len(entries))
	for _, entry := range entries {
		fsEntry := FsEntry{Name: entry.Name(), Path: filepath.Join(rel, entry.Name())}
		switch {
		case entry.Type()&fs.ModeSymlink != 0:
			fsEntry.Type = "symlink"
		case entry.IsDir():
			fsEntry.Type = "dir"
		default:
			fsEntry.Type = "file"
			if info, err := entry.Info(); err == nil {
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

// ReadFile reads up to maxBytes from rel within the station's workspace.
func (k *kiloDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	wsPath, err := k.workspacePathForKey(key)
	if err != nil {
		return nil, "", false, err
	}
	target, err := safeJoin(wsPath, rel)
	if err != nil {
		return nil, "", false, err
	}
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}

	f, err := os.Open(target)
	if err != nil {
		return nil, "", false, fmt.Errorf("kilo: ReadFile %q: %w", target, err)
	}
	defer f.Close()

	// One byte past the limit, so a file exactly at the limit is not reported
	// truncated. The encoding hint is left empty, as every other descriptor
	// leaves it: the hub decides how to present the bytes.
	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, "", false, fmt.Errorf("kilo: ReadFile read %q: %w", target, err)
	}
	truncated := int64(n) > maxBytes
	if truncated {
		n = int(maxBytes)
	}
	return buf[:n], "", truncated, nil
}

// CleanPlan proposes the reclaimable directories in a Kilo workspace.
func (k *kiloDescriptor) CleanPlan(key string) ([]CleanItem, error) {
	wsPath, err := k.workspacePathForKey(key)
	if err != nil {
		return nil, err
	}
	return cleanPlanCommon(wsPath, []string{".cache", "tmp"})
}

// CleanApply removes the paths the operator chose from a plan.
func (k *kiloDescriptor) CleanApply(key string, paths []string) (int64, error) {
	wsPath, err := k.workspacePathForKey(key)
	if err != nil {
		return 0, err
	}
	plan, err := k.CleanPlan(key)
	if err != nil {
		return 0, err
	}
	return cleanApplyCommon(wsPath, paths, plan)
}

// TailLogs streams this host's Kilo logs.
//
// Kilo writes global log files under <dataDir>/log, not per project — the same
// shape opencode has — so this tails the host's recent logs rather than only
// the ones belonging to this station. The key is still resolved first, so an
// unknown station is refused rather than served another station's logs.
func (k *kiloDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	if _, err := k.workspacePathForKey(key); err != nil {
		return err
	}

	collect := func() []string { return collectKiloLogFiles(filepath.Join(k.dataDir, "log")) }
	logFiles := collect()

	if !follow {
		return emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit)
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
			for _, path := range collect() {
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

// kiloRecentLogFiles bounds how many log files a tail follows, newest first. A
// long-lived host accumulates one per run; following all of them would open an
// unbounded number of files for a single log view.
const kiloRecentLogFiles = 20

// collectKiloLogFiles returns the newest log files under logDir, newest first.
// A missing directory yields nothing rather than an error.
func collectKiloLogFiles(logDir string) []string {
	matches, err := filepath.Glob(filepath.Join(logDir, "*.log"))
	if err != nil {
		return nil
	}

	type stamped struct {
		path string
		mod  time.Time
	}
	stamps := make([]stamped, 0, len(matches))
	for _, f := range matches {
		info, err := os.Stat(f)
		if err != nil {
			continue
		}
		stamps = append(stamps, stamped{path: f, mod: info.ModTime()})
	}
	sort.Slice(stamps, func(i, j int) bool { return stamps[i].mod.After(stamps[j].mod) })

	out := make([]string, 0, len(stamps))
	for i, s := range stamps {
		if i >= kiloRecentLogFiles {
			break
		}
		out = append(out, s.path)
	}
	return out
}
