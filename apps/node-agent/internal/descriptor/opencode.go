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
	"strings"
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
// <dataDir>/project/ dirs and decoding the sanitised names.
//
// Decode ambiguity (fallback only): OpenCode sanitises project paths by
// stripping the leading '/' and replacing remaining '/' with '-'. When
// decoding back, all '-' become '/' and a '/' is prepended. Path components
// that contain '-' in their original names are decoded incorrectly (e.g.
// demo-creditcheck → demo/creditcheck). This is inherent to the sanitisation
// scheme; non-existent decoded paths are silently filtered out.
type openCodeDescriptor struct {
	dataDir string // absolute path to ~/.local/share/opencode
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
			Capabilities:  caps,
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
		return paths, nil
	}

	log.Printf("opencode: could not read %s (%v); "+
		"falling back to project/ directory enumeration "+
		"(note: decoded paths may be ambiguous when project names contain '-')", dbPath, err)
	return o.projectPathsFromDirs()
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

// openCodeProcessRunning checks for any running opencode process via pgrep.
// Returns false with a note when the check is unavailable.
func openCodeProcessRunning() (running bool, note string) {
	cmd := exec.Command("pgrep", "-f", "opencode")
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
