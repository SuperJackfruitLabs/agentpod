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

	// ACP adapter settings — see CodexConfig. All optional.
	acpBinary   string
	codexBinary string
	nodeBinary  string

	// Host seams. These are fields so no test needs codex, node or npx
	// installed, none touches the host's PATH or filesystem and none spawns a
	// pgrep-visible child; production wiring in NewCodexFrom uses the real host.
	processRunning func(projPath string) (running bool, note string)
	userHome       string                                // OS user home; "" omits home-relative candidates
	lookPath       func(string) (string, error)          // exec.LookPath
	isExecutable   func(string) bool                     // isExecutableFile
	nodeVersion    func(nodePath string) (string, error) // `node --version`
	getenv         func(string) string                   // os.Getenv
}

// CodexConfig carries everything the descriptor needs. Zero values are valid: an
// unconfigured host still detects stations, and an ACP session still starts as
// long as the adapter (or npx) is reachable on PATH.
type CodexConfig struct {
	Home        string // path to the ~/.codex directory; default <user home>/.codex
	AcpBinary   string // a codex-acp executable; empty = resolve it
	CodexBinary string // the codex CLI, for CODEX_PATH; empty = resolve it
	NodeBinary  string // the node runtime, when it isn't on the service's PATH
}

// NewCodex returns a Descriptor for the Codex harness.
// home is the path to the ~/.codex directory. If empty it defaults to
// $HOME/.codex.
func NewCodex(home string) Descriptor {
	return NewCodexFrom(CodexConfig{Home: home})
}

// NewCodexFrom returns a Descriptor for the Codex harness configured by cfg.
func NewCodexFrom(cfg CodexConfig) Descriptor {
	// userHome is "" when it can't be determined, which the binary locator
	// reads as "skip the home-relative candidates".
	userHome, err := os.UserHomeDir()
	if err != nil {
		userHome = ""
	}
	home := cfg.Home
	if home == "" {
		base := userHome
		if base == "" {
			base = "."
		}
		home = filepath.Join(base, ".codex")
	}
	return &codexDescriptor{
		home:           home,
		acpBinary:      cfg.AcpBinary,
		codexBinary:    cfg.CodexBinary,
		nodeBinary:     cfg.NodeBinary,
		processRunning: codexProcessRunning,
		userHome:       userHome,
		lookPath:       exec.LookPath,
		isExecutable:   isExecutableFile,
		nodeVersion:    nodeVersionOutput,
		getenv:         os.Getenv,
	}
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

	// "acp" is advertised because *codexDescriptor implements ACPCommander (via
	// the external codex-acp adapter — see ACPCommand).
	caps := []string{"health", "logs", "fs.read", "fs.write", "terminal", "cleanup", "acp"}

	stations := []Station{}
	for _, projPath := range parseCodexProjectPaths(data) {
		// A relative key cannot be a workspace root: it would resolve against
		// the SERVICE's cwd, and that resolution becomes the fs.read root and the
		// CleanApply root. Codex writes absolute paths; anything else is a
		// hand-edit we refuse rather than guess at.
		if !filepath.IsAbs(projPath) {
			continue
		}
		// Only "it is gone" drops a station. A transient stat failure (EACCES on
		// a briefly-unavailable mount, say) must not make a station blink out of
		// the fleet view — same rule as claude-code.
		if _, err := os.Stat(projPath); os.IsNotExist(err) {
			continue
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

// Codex has no ACP mode of its own: sessions run through the external codex-acp
// adapter, a Node program that speaks ACP on stdio and drives `codex
// app-server` underneath.
const (
	// codexACPBinaryName is the adapter's executable name once installed.
	codexACPBinaryName = "codex-acp"
	// codexACPPackage is the npx fallback, VERSION-PINNED on purpose: an
	// unpinned `npx -y <pkg>` would silently change every node's adapter the
	// moment a new version is published, mid-flight, with no way to tell which
	// version a session actually ran.
	codexACPPackage = "@agentclientprotocol/codex-acp@1.1.14"
	// codexACPMinNodeMajor is 0 — "no minimum" — NOT an oversight: unlike
	// claude-agent-acp (node >= 22), codex-acp declares no `engines` field at
	// all, so there is no documented requirement to enforce. The runtime is
	// still SELECTED the same way, so a configured nodeBinary wins the spawn;
	// what is deliberately skipped is the REFUSAL. Inventing a floor here would
	// cost sessions on hosts the package supports, and the adapter's own error
	// is the honest one if its node really is too old.
	codexACPMinNodeMajor = 0
)

// locator returns the executable resolver for this node. preferDirs (when any)
// are probed ahead of PATH — see selectNodeRuntimeDir.
func (c *codexDescriptor) locator(preferDirs ...string) binaryLocator {
	return binaryLocator{
		userHome:     c.userHome,
		preferDirs:   preferDirs,
		lookPath:     c.lookPath,
		isExecutable: c.isExecutable,
	}
}

// ACPCommand implements ACPCommander. There is no `codex acp`: the command
// spawned is the codex-acp adapter, resolved in order — the codexAcpBinary
// override, an installed adapter (PATH then the well-known install dirs), then a
// version-pinned `npx -y`. The working directory is the station's project path,
// the same one the Files, Health and Cleanup tabs use.
//
// No credential is ever put in argv (world-readable via ps) or env. Codex key
// auth (CODEX_API_KEY / OPENAI_API_KEY) is read by the adapter from the
// environment it INHERITS — i.e. the node-agent service's own environment, where
// an operator can protect it — and is never lifted out of the node config, which
// would publish it to every `ps` on the host. Otherwise:
//
//   - NO_BROWSER=1 always: it hides the browser-based ChatGPT login, which is
//     meaningless on a headless fleet node and would otherwise be offered (and
//     attempted) with no one there to complete it. ChatGPT-login auth comes from
//     a prior interactive `codex login` on the node instead.
//   - CODEX_PATH when a codex resolves on the node: without it the adapter runs
//     the Codex build bundled with its own npm dependency, so a chat session and
//     the station's Health tab would be reporting two different installs.
//   - PATH when, and only when, a configured node runtime is in play.
func (c *codexDescriptor) ACPCommand(key string) ([]string, string, []string, error) {
	// The station must exist before anything is probed on the host: an unknown
	// key has no project directory to run in.
	projPath, err := c.projectPathForKey(key)
	if err != nil {
		return nil, "", nil, err
	}

	// Selected, never refused — see codexACPMinNodeMajor. tooOld is always empty
	// with a zero minimum, so it is discarded rather than checked.
	//
	// The probe is skipped entirely without a configured runtime, and that is a
	// correctness-preserving shortcut rather than an optimisation: with no
	// version to enforce, the selector can only return a non-empty dir when the
	// winner IS the configured node, so unconfigured means the answer is
	// structurally "". Running it anyway would fork `node --version` on every
	// acp.open for a result that cannot change argv or env — and on a host whose
	// node lives on a stalled network mount, pay the full timeout for it before
	// argv is even resolved. (claude-code cannot take this shortcut: its probe
	// also decides whether to REFUSE.)
	var nodeDir string
	if c.nodeBinary != "" {
		nodeDir, _ = selectNodeRuntimeDir(c.nodeBinary, codexACPMinNodeMajor, c.locator(), c.nodeVersion)
	}

	env := []string{
		"NO_BROWSER=1",
		// The agent's permission posture is OURS, set explicitly rather than
		// inherited from whatever the adapter defaults to. "agent" is the
		// approval-seeking mode: the console gates the Chat tab on the "acp"
		// capability alone, so every detected Codex project gains a Chat tab the
		// moment a node updates, and the hub's ask/accept-edits/full-auto modes
		// are only a safety net if the agent actually requests permission. The
		// third mode — the full access one — is deliberately never used here: an
		// unattended fleet node is the worst possible place to hand an agent
		// unprompted write-and-execute, and there is no config key to opt into it.
		"INITIAL_AGENT_MODE=agent",
	}
	// A configured node only genuinely wins if the adapter's own child processes
	// see it first — npx resolves `node` through PATH.
	if nodeDir != "" {
		env = append(env, "PATH="+pathWithDirFirst(nodeDir, c.getenv("PATH")))
	}
	if codexPath, ok := c.locator().locate("codex", c.codexBinary); ok {
		env = append(env, "CODEX_PATH="+codexPath)
	}

	// An installed adapter beats npx: it starts immediately and can't change
	// under us between two sessions.
	if adapter, ok := c.locator().locate(codexACPBinaryName, c.acpBinary); ok {
		return []string{adapter}, projPath, env, nil
	}

	// npx is resolved from the configured runtime's directory first: PATH's npx
	// belongs to PATH's node, which is the one we just stepped over.
	var preferDirs []string
	if nodeDir != "" {
		preferDirs = append(preferDirs, nodeDir)
	}
	npx, ok := c.locator(preferDirs...).locate("npx", "")
	if !ok {
		return nil, "", nil, fmt.Errorf("codex: couldn't find codex-acp or npx on this node — set codexAcpBinary in the node config")
	}
	return []string{npx, "-y", codexACPPackage}, projPath, env, nil
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
