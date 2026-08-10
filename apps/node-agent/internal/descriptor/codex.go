package descriptor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// codexDescriptor implements Descriptor for the Codex leaf harness.
//
// Codex is a project-workspace harness with no persistent process: each trusted
// project directory is a leaf station. The home layout is:
//
//	~/.codex/
//	  config.toml        ← model/API config; one [projects."<abs path>"] table
//	                        per workspace Codex has been run in
//	  sessions/
//	    <yyyy>/<mm>/<dd>/
//	      rollout-*.jsonl ← session transcripts, bucketed by date (NOT by project)
//
// Key format: "codex:<8-hex-char SHA256 prefix of the project path>", the same
// scheme claude-code and opencode use.
//
// Detection reads the [projects."<path>"] table keys, which are authoritative
// and need no dependency on the (undocumented) rollout JSONL format. Project
// directories that no longer exist on disk are filtered out.
type codexDescriptor struct {
	home string // absolute path to ~/.codex

	// Host seam: the "is a codex session running here" probe. It is a field so
	// no test needs codex installed and none spawns a pgrep-visible child;
	// production wiring in NewCodex uses the real host.
	processRunning func(projPath string) (running bool, note string)
}

// NewCodex returns a Descriptor for the Codex harness.
// home is the path to the ~/.codex directory. If empty it defaults to
// $HOME/.codex.
func NewCodex(home string) Descriptor {
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			userHome = "."
		}
		home = filepath.Join(userHome, ".codex")
	}
	return &codexDescriptor{home: home, processRunning: codexProcessRunning}
}

// Harness returns the harness identifier.
func (c *codexDescriptor) Harness() string { return "codex" }

// codexProjectKey derives a stable station key from a project directory path.
// Uses the first 4 bytes (8 hex chars) of SHA256(path) for brevity.
func codexProjectKey(projPath string) string {
	h := sha256.Sum256([]byte(projPath))
	return fmt.Sprintf("codex:%x", h[:4])
}

// configPath returns the path to ~/.codex/config.toml.
func (c *codexDescriptor) configPath() string {
	return filepath.Join(c.home, "config.toml")
}

// Detect discovers leaf stations by reading the [projects."<path>"] tables in
// ~/.codex/config.toml. Only project directories that still exist on disk are
// returned; a missing home or config yields an empty (non-nil) slice.
func (c *codexDescriptor) Detect() ([]Station, error) {
	data, err := os.ReadFile(c.configPath())
	if err != nil {
		if os.IsNotExist(err) {
			// No codex home, or codex has never written a config: no stations.
			return []Station{}, nil
		}
		return nil, fmt.Errorf("codex: reading %s: %w", c.configPath(), err)
	}

	// "acp" is NOT advertised: the contract ties it to implementing
	// ACPCommander, and codex has no ACP bridge here yet.
	caps := []string{"health", "logs", "fs.read", "fs.write", "terminal", "cleanup"}

	stations := []Station{}
	for _, projPath := range parseCodexProjectPaths(data) {
		if _, err := os.Stat(projPath); err != nil {
			continue // project directory was deleted (or is unreadable)
		}
		wsCopy := projPath
		stations = append(stations, Station{
			Key:           codexProjectKey(projPath),
			Harness:       "codex",
			Kind:          "leaf",
			DisplayName:   filepath.Base(projPath),
			ParentKey:     nil,
			WorkspacePath: &wsCopy,
			Capabilities:  caps,
		})
	}
	return stations, nil
}

// parseCodexProjectPaths extracts the project paths from the
// [projects."<path>"] table headers in a config.toml, in file order and
// deduplicated.
//
// This is a deliberately narrow scan rather than a full TOML parse: node-agent
// has no TOML dependency and adding one for three lines of table headers is not
// worth it. It handles what codex actually writes and what a hand-edited config
// plausibly contains — basic ("…") and literal ('…') quoted keys including
// spaces and escapes, whitespace around the dots, nested subtables
// ([projects."<path>".sub]) — and ignores everything else: other tables,
// top-level keys, comments, array-of-table headers and bare (unquoted) keys,
// which can never be a path.
//
// Known limitation: a table header appearing inside a multi-line string value
// would be misread. Codex does not write such values, and a false positive is
// filtered out by the "does this directory exist" check in Detect anyway.
func parseCodexProjectPaths(data []byte) []string {
	var paths []string
	seen := map[string]bool{}

	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		// Table headers only. "[[" is an array-of-tables header, never a
		// projects entry.
		if !strings.HasPrefix(line, "[") || strings.HasPrefix(line, "[[") {
			continue
		}

		parts, quoted, ok := parseCodexTableKey(line[1:])
		if !ok || len(parts) < 2 {
			continue
		}
		// The path is the first key segment under "projects", and it must have
		// been quoted: a bare key cannot contain '/'.
		if parts[0] != "projects" || !quoted[1] {
			continue
		}
		path := parts[1]
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		paths = append(paths, path)
	}
	return paths
}

// parseCodexTableKey parses a TOML table header's dotted key, given everything
// after the opening '['. It returns the key segments, whether each segment was
// quoted, and false if the header is malformed or uses a key syntax this scan
// does not understand.
func parseCodexTableKey(s string) (parts []string, quoted []bool, ok bool) {
	for {
		s = strings.TrimLeft(s, " \t")
		if s == "" {
			return nil, nil, false
		}

		var part string
		var wasQuoted bool
		switch s[0] {
		case '"':
			part, s, ok = parseCodexBasicString(s)
			if !ok {
				return nil, nil, false
			}
			wasQuoted = true
		case '\'':
			end := strings.IndexByte(s[1:], '\'')
			if end < 0 {
				return nil, nil, false
			}
			part, s = s[1:1+end], s[end+2:]
			wasQuoted = true
		default:
			// Bare key: runs until whitespace, '.' or ']'.
			end := strings.IndexAny(s, " \t.]")
			if end < 0 {
				return nil, nil, false
			}
			part, s = s[:end], s[end:]
		}
		parts = append(parts, part)
		quoted = append(quoted, wasQuoted)

		s = strings.TrimLeft(s, " \t")
		if s == "" {
			return nil, nil, false
		}
		switch s[0] {
		case '.':
			s = s[1:]
		case ']':
			return parts, quoted, true
		default:
			return nil, nil, false
		}
	}
}

// parseCodexBasicString reads a TOML basic string starting at s[0] == '"' and
// returns its unescaped value plus the remainder of the line. Unsupported
// escapes (\u, \U) make it fail rather than guess.
func parseCodexBasicString(s string) (value, rest string, ok bool) {
	var b strings.Builder
	for i := 1; i < len(s); i++ {
		switch s[i] {
		case '"':
			return b.String(), s[i+1:], true
		case '\\':
			i++
			if i >= len(s) {
				return "", "", false
			}
			switch s[i] {
			case '"', '\\':
				b.WriteByte(s[i])
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			default:
				return "", "", false
			}
		default:
			b.WriteByte(s[i])
		}
	}
	return "", "", false
}

// projectPathForKey resolves a station key back to its project directory path
// by re-running Detect and filtering by key.
func (c *codexDescriptor) projectPathForKey(key string) (string, error) {
	stations, err := c.Detect()
	if err != nil {
		return "", err
	}
	for _, s := range stations {
		if s.Key == key && s.WorkspacePath != nil {
			return *s.WorkspacePath, nil
		}
	}
	return "", fmt.Errorf("codex: station not found: %q", key)
}

// Health returns a best-effort liveness/resource snapshot for a leaf station.
//
// Running comes from a best-effort check for a codex process whose cwd is
// inside the project; false is returned when the check is undeterminable (see
// Note). DiskBytes walks the project workspace via the shared async cache.
//
// LastActivity is deliberately left unset: codex buckets its rollout
// transcripts by date (~/.codex/sessions/<yyyy>/<mm>/<dd>/) rather than by
// project, so their mtimes describe the host, not this station. Reporting the
// same timestamp on every codex station would be worse than reporting none.
func (c *codexDescriptor) Health(key string) (Health, error) {
	projPath, err := c.projectPathForKey(key)
	if err != nil {
		return Health{}, err
	}

	health := Health{}

	// Disk usage from the shared async cache — never walk on the request path
	// (a node_modules-laden workspace walk can exceed the hub's timeout).
	health.DiskBytes = diskUsage(projPath)

	running, note := c.processRunning(projPath)
	health.Running = running
	if note != "" {
		health.Note = &note
	}

	return health, nil
}

// codexProcessRunning reports whether a codex CLI session is running with its
// working directory inside projPath. Always best-effort — see
// processRunningInWorkspace.
func codexProcessRunning(projPath string) (running bool, note string) {
	return processRunningInWorkspace("^codex", projPath)
}

// ListDir lists the directory at rel within the project workspace.
// Paths that escape the workspace via ".." are rejected.
func (c *codexDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
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
		return nil, fmt.Errorf("codex: ListDir %q: %w", target, err)
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

// ReadFile reads up to maxBytes from rel within the project workspace.
func (c *codexDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
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
		return nil, "", false, fmt.Errorf("codex: ReadFile %q: %w", target, err)
	}
	defer f.Close()

	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, "", false, fmt.Errorf("codex: ReadFile read %q: %w", target, err)
	}

	truncated := int64(n) > maxBytes
	if truncated {
		n = int(maxBytes)
	}
	return buf[:n], "", truncated, nil
}

// CleanPlan returns the cleanable items for the Codex station.
// Cleanable: ".cache" and "tmp" subdirectories + *.log files at workspace root.
func (c *codexDescriptor) CleanPlan(key string) ([]CleanItem, error) {
	projPath, err := c.projectPathForKey(key)
	if err != nil {
		return nil, err
	}
	return cleanPlanCommon(projPath, []string{".cache", "tmp"})
}

// CleanApply removes selected cleanable paths from the Codex workspace.
func (c *codexDescriptor) CleanApply(key string, paths []string) (int64, error) {
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

// TailLogs emits session transcripts from ~/.codex/sessions/. The key is
// validated so an unknown station fails loudly instead of streaming the host's
// logs, but the content itself is host-wide, NOT station-scoped: codex buckets
// rollout files by date and the only record of a session's cwd lives inside the
// (undocumented) JSONL payload. Scoping them per project means depending on
// that format, which is out of scope here.
func (c *codexDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	if _, err := c.projectPathForKey(key); err != nil {
		return err
	}

	sessDir := filepath.Join(c.home, "sessions")
	collect := func() []string { return collectCodexLogFiles(sessDir) }
	logFiles := collect()

	if !follow {
		return emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit)
	}

	// Follow mode: wait for a log file to exist (a harness that hasn't
	// written logs yet must not close the stream immediately), then emit its
	// content and poll for appends.
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
			logFiles = collectCodexLogFiles(sessDir)
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

// collectCodexLogFiles walks sessDir and returns all regular files, analogous
// to collectLogFiles used by the Hermes descriptor.
func collectCodexLogFiles(sessDir string) []string {
	var files []string
	_ = filepath.WalkDir(sessDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	return files
}
