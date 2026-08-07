package descriptor

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// claudeCodeDescriptor implements Descriptor for the Claude Code leaf harness.
//
// Claude Code is a project-workspace harness with no persistent process: each
// project directory is a leaf station. The home layout is:
//
//	~/.claude.json        ← per-user config; "projects" object keys are
//	                         absolute project directory paths
//	~/.claude/
//	  projects/
//	    <sanitised-cwd>/  ← cwd with '/' replaced by '-'
//	      *.jsonl         ← session transcripts
//
// Key format: "claude-code:<8-hex-char SHA256 prefix of the project path>"
type claudeCodeDescriptor struct {
	home    string // absolute path to ~/.claude
	jsonDir string // absolute path to ~/ (parent of home; .claude.json lives here)
}

// NewClaudeCode returns a Descriptor for the Claude Code harness.
// home is the path to the ~/.claude directory. If empty it defaults to
// $HOME/.claude. The .claude.json file is read from filepath.Dir(home).
func NewClaudeCode(home string) Descriptor {
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			userHome = "."
		}
		home = filepath.Join(userHome, ".claude")
	}
	return &claudeCodeDescriptor{
		home:    home,
		jsonDir: filepath.Dir(home),
	}
}

// Harness returns the harness identifier.
func (c *claudeCodeDescriptor) Harness() string { return "claude-code" }

// claudeProjectKey derives a stable station key from a project directory path.
// Uses the first 4 bytes (8 hex chars) of SHA256(path) for brevity.
func claudeProjectKey(projPath string) string {
	h := sha256.Sum256([]byte(projPath))
	return fmt.Sprintf("claude-code:%x", h[:4])
}

// sanitiseClaudePath converts a project directory path to the sanitised
// directory name Claude Code uses under ~/.claude/projects/:  '/' → '-'.
func sanitiseClaudePath(p string) string {
	return strings.ReplaceAll(p, "/", "-")
}

// Detect discovers leaf stations by reading ~/.claude.json (or falling back
// to listing ~/.claude/projects/*). Only project directories that still exist
// on disk are returned.
func (c *claudeCodeDescriptor) Detect() ([]Station, error) {
	// Both the home and the json dir must be reachable.
	if _, err := os.Stat(c.home); os.IsNotExist(err) {
		if _, err2 := os.Stat(filepath.Join(c.jsonDir, ".claude.json")); os.IsNotExist(err2) {
			return []Station{}, nil
		}
	}

	paths, err := c.loadProjectPaths()
	if err != nil {
		return nil, err
	}

	caps := []string{"health", "logs", "fs.read", "fs.write", "terminal", "cleanup"}
	var stations []Station

	for _, projPath := range paths {
		if _, err := os.Stat(projPath); os.IsNotExist(err) {
			continue // project directory was deleted
		}
		key := claudeProjectKey(projPath)
		wsCopy := projPath
		stations = append(stations, Station{
			Key:           key,
			Harness:       "claude-code",
			Kind:          "leaf",
			DisplayName:   filepath.Base(projPath),
			ParentKey:     nil,
			WorkspacePath: &wsCopy,
			Capabilities:  caps,
		})
	}

	if stations == nil {
		stations = []Station{}
	}
	return stations, nil
}

// loadProjectPaths returns project directory paths by parsing ~/.claude.json.
// Falls back to listing ~/.claude/projects/* and decoding the sanitised names
// if the JSON file is absent (and logs the fact clearly).
func (c *claudeCodeDescriptor) loadProjectPaths() ([]string, error) {
	jsonPath := filepath.Join(c.jsonDir, ".claude.json")

	data, err := os.ReadFile(jsonPath)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("claude-code: .claude.json not found at %s; "+
				"falling back to ~/.claude/projects/ directory enumeration "+
				"(note: decoded paths may be ambiguous when project names contain '-')", jsonPath)
			return c.projectPathsFromSessionDirs()
		}
		return nil, fmt.Errorf("claude-code: reading .claude.json: %w", err)
	}

	// ~/.claude.json has the shape:
	//   { "projects": { "/abs/path": { ... }, ... }, ... }
	var doc struct {
		Projects map[string]json.RawMessage `json:"projects"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("claude-code: parsing .claude.json: %w", err)
	}

	paths := make([]string, 0, len(doc.Projects))
	for k := range doc.Projects {
		paths = append(paths, k)
	}
	return paths, nil
}

// projectPathsFromSessionDirs lists ~/.claude/projects/ and decodes each
// sanitised directory name back to an absolute path by replacing '-' with '/'.
// This is a best-effort fallback; path components that contain '-' will be
// decoded incorrectly.
func (c *claudeCodeDescriptor) projectPathsFromSessionDirs() ([]string, error) {
	projsDir := filepath.Join(c.home, "projects")
	entries, err := os.ReadDir(projsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("claude-code: listing %s: %w", projsDir, err)
	}

	var paths []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		// Decode: '-' → '/' (the leading '-' gives back the leading '/').
		decoded := strings.ReplaceAll(e.Name(), "-", "/")
		paths = append(paths, decoded)
	}
	return paths, nil
}

// sessionDirFor returns the session directory path for projPath under
// ~/.claude/projects/<sanitised-path>/.
func (c *claudeCodeDescriptor) sessionDirFor(projPath string) string {
	return filepath.Join(c.home, "projects", sanitiseClaudePath(projPath))
}

// projectPathForKey resolves a station key back to its project directory path
// by re-running Detect and filtering by key.
func (c *claudeCodeDescriptor) projectPathForKey(key string) (string, error) {
	stations, err := c.Detect()
	if err != nil {
		return "", err
	}
	for _, s := range stations {
		if s.Key == key && s.WorkspacePath != nil {
			return *s.WorkspacePath, nil
		}
	}
	return "", fmt.Errorf("claude-code: station not found: %q", key)
}

// Health returns a best-effort liveness/resource snapshot for a leaf station.
//
// Running is set via a best-effort check for a claude process whose cwd
// matches projPath; false is returned if the check is undeterminable (see
// Note). DiskBytes walks the project workspace. LastActivity reflects the
// newest mtime in the session transcript directory.
func (c *claudeCodeDescriptor) Health(key string) (Health, error) {
	projPath, err := c.projectPathForKey(key)
	if err != nil {
		return Health{}, err
	}

	health := Health{}

	// Disk usage from the shared async cache — never walk on the request path
	// (a node_modules-laden workspace walk can exceed the hub's timeout).
	health.DiskBytes = diskUsage(projPath)

	// Best-effort: detect a running claude process.
	running, note := claudeProcessRunning(projPath)
	health.Running = running
	if note != "" {
		health.Note = &note
	}

	// LastActivity: newest mtime across all files in the session dir.
	sessDir := c.sessionDirFor(projPath)
	if newest := newestMtime(sessDir); !newest.IsZero() {
		s := newest.UTC().Format(time.RFC3339)
		health.LastActivity = &s
	}

	return health, nil
}

// claudeProcessRunning checks for a running claude process whose working
// directory is projPath. Returns false with a note when the check is
// unavailable (e.g. lsof not installed). This is always best-effort.
// parseLsofCwds parses `lsof -Fn -d cwd` field output (p<pid> / f<fd> /
// n<path> line groups) into pid→cwd.
func parseLsofCwds(out []byte) map[int]string {
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

// cwdWithinWorkspace reports whether cwd is the workspace itself or nested
// inside it (a session that cd'd into a subdirectory still counts). Both
// sides are symlink-resolved when possible — lsof reports resolved paths
// (e.g. /private/var on macOS for a /var workspace), so a literal compare
// would miss real matches.
func cwdWithinWorkspace(cwd, workspace string) bool {
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

// claudeProcessRunning reports whether a claude CLI session is running with
// its working directory inside projPath.
//
// Detection is cwd-based: `pgrep '^claude'` finds candidate pids by process
// name (ps/pgrep see "claude"), then one lsof call resolves their cwds.
// Selecting by name inside lsof (-c claude) does NOT work — the claude CLI
// rewrites its process title to its version string (e.g. "2.1.222"), and
// lsof's `+d dir` does not match a process whose cwd is the directory anyway.
// lsof's exit code is ignored when it produced output: it exits 1 on benign
// per-file warnings even with valid matches (the old code read that as
// "stopped" while sessions were running).
func claudeProcessRunning(projPath string) (running bool, note string) {
	out, err := exec.Command("pgrep", "^claude").Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return false, "" // no claude processes at all
		}
		return false, "process check unavailable (pgrep not found or failed)"
	}
	pids := strings.Fields(strings.TrimSpace(string(out)))
	if len(pids) == 0 {
		return false, ""
	}

	lsofOut, err := exec.Command("lsof", "-a", "-p", strings.Join(pids, ","), "-d", "cwd", "-Fn").Output()
	if err != nil && len(lsofOut) == 0 {
		if _, ok := err.(*exec.ExitError); ok {
			return false, "" // ran but matched nothing
		}
		return false, "process check unavailable (lsof not found or failed)"
	}
	for _, cwd := range parseLsofCwds(lsofOut) {
		if cwdWithinWorkspace(cwd, projPath) {
			return true, ""
		}
	}
	return false, ""
}

// newestMtime returns the newest modification time among all regular files
// found under dir. Returns zero time if dir is absent or empty.
func newestMtime(dir string) time.Time {
	var newest time.Time
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
		return nil
	})
	return newest
}

// ListDir lists the directory at rel within the project workspace.
// Paths that escape the workspace via ".." are rejected.
func (c *claudeCodeDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	projPath, err := c.projectPathForKey(key)
	if err != nil {
		return nil, err
	}

	target, err := safeJoin(projPath, rel)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, fmt.Errorf("claude-code: ListDir %q: %w", target, err)
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
func (c *claudeCodeDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	projPath, err := c.projectPathForKey(key)
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
		return nil, "", false, fmt.Errorf("claude-code: ReadFile %q: %w", target, err)
	}
	defer f.Close()

	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, "", false, fmt.Errorf("claude-code: ReadFile read %q: %w", target, err)
	}

	truncated := int64(n) > maxBytes
	if truncated {
		n = int(maxBytes)
	}
	return buf[:n], "", truncated, nil
}

// TailLogs emits session transcript (.jsonl) files from the project's session
// directory. If follow is true it polls for new content until ctx is done.
func (c *claudeCodeDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	projPath, err := c.projectPathForKey(key)
	if err != nil {
		return err
	}

	sessDir := c.sessionDirFor(projPath)
	logFiles := collectJsonlFiles(sessDir)

	if !follow {
		// One-shot: emit the last N lines of existing content.
		return emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit)
	}

	// Follow mode: emit the last N lines first, then poll for appends.
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
			logFiles = collectJsonlFiles(sessDir)
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

// CleanPlan returns the cleanable items for the Claude Code station.
// Cleanable: ".cache" and "tmp" subdirectories + *.log files at workspace root.
func (c *claudeCodeDescriptor) CleanPlan(key string) ([]CleanItem, error) {
	projPath, err := c.projectPathForKey(key)
	if err != nil {
		return nil, err
	}
	return cleanPlanCommon(projPath, []string{".cache", "tmp"})
}

// CleanApply removes selected cleanable paths from the Claude Code workspace.
func (c *claudeCodeDescriptor) CleanApply(key string, paths []string) (int64, error) {
	projPath, err := c.projectPathForKey(key)
	if err != nil {
		return 0, err
	}
	plan, err := c.CleanPlan(key)
	if err != nil {
		return 0, err
	}
	return cleanApplyCommon(projPath, paths, plan)
}

// collectJsonlFiles walks dir and returns paths of all .jsonl files.
// Missing directories are silently skipped.
func collectJsonlFiles(dir string) []string {
	var files []string
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && strings.ToLower(filepath.Ext(d.Name())) == ".jsonl" {
			files = append(files, path)
		}
		return nil
	})
	return files
}
