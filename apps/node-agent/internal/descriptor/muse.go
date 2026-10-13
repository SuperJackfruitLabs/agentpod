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

// museDescriptor implements Descriptor for the Muse Code leaf harness.
//
// Muse is a project-workspace harness with no persistent process: each
// workspace Muse has been run in is a leaf station. The home layout, as the
// host itself reports it in the `museHome` field of an MSP `initialize`
// response, is:
//
//	~/.local/share/muse/
//	  session-index.db   ← SQLite; one `sessions` row per session, carrying
//	                       workspace_root, session_dir and session_log_path
//	  sessions/
//	    <yyyy>/<mm>/<dd>/<session-id>/session.jsonl
//	  skills/bundled/    ← the skills `muse skills list` reports
//	  plugins/cache/
//
// Key format: "muse:<8-hex-char SHA256 prefix of the workspace path>", the same
// scheme codex, claude-code and opencode use.
//
// Detection reads `sessions.workspace_root` from the index, which is
// authoritative and spares us the session JSONL format. Workspaces that no
// longer exist on disk are filtered out.
//
// Muse speaks its own Muse Session Protocol, not ACP, so chat runs through the
// external muse-acp adapter — the same shape as codex-acp and pi-acp.
type museDescriptor struct {
	home string // absolute path to the muse home (museHome)

	// ACP adapter settings — see MuseConfig. All optional.
	acpBinary  string
	museBinary string

	// Host seams. These are fields so no test needs muse, muse-acp or sqlite3
	// installed, none touches the host's PATH or filesystem, and none spawns a
	// pgrep-visible child; production wiring in NewMuseFrom uses the real host.
	workspaceRoots func(dbPath string) ([]string, error)
	processRunning func(wsPath string) (running bool, note string)
	userHome       string                       // OS user home; "" omits home-relative candidates
	lookPath       func(string) (string, error) // exec.LookPath
	isExecutable   func(string) bool            // isExecutableFile
	getenv         func(string) string          // os.Getenv
}

// MuseConfig carries everything the descriptor needs. Zero values are valid: an
// unconfigured host still detects stations, and an ACP session still starts as
// long as both the adapter and muse are reachable on PATH.
type MuseConfig struct {
	Home string // the muse home; default $XDG_DATA_HOME/muse, else <user home>/.local/share/muse
	// AcpBinary is a muse-acp executable; empty = resolve it.
	AcpBinary string
	// MuseBinary is the muse CLI the adapter drives, exported to it as
	// MUSE_CLI. Empty = resolve it; the adapter's own default is "muse" on
	// PATH, and naming one here is how an operator pins a specific install.
	MuseBinary string
}

const (
	// museBinaryName is the Muse Code CLI.
	museBinaryName = "muse"
	// museACPBinaryName is the adapter's executable name once installed. It is
	// a prebuilt binary — unlike codex-acp and claude-agent-acp there is no npx
	// fallback to reach for, and no Node runtime to version-check.
	museACPBinaryName = "muse-acp"
	// museCLIEnv is how muse-acp is told which muse to drive. Without it the
	// adapter resolves "muse" from PATH, which is not necessarily the install
	// this node detected stations from.
	museCLIEnv = "MUSE_CLI"
)

// NewMuse returns a Descriptor for the Muse Code harness. home is the muse home
// directory; if empty it defaults to the XDG data location.
func NewMuse(home string) Descriptor {
	return NewMuseFrom(MuseConfig{Home: home})
}

// NewMuseFrom returns a Descriptor for the Muse Code harness configured by cfg.
func NewMuseFrom(cfg MuseConfig) Descriptor {
	// userHome is "" when it can't be determined, which the binary locator
	// reads as "skip the home-relative candidates".
	userHome, err := os.UserHomeDir()
	if err != nil {
		userHome = ""
	}
	home := cfg.Home
	if home == "" {
		home = defaultMuseHome(userHome, os.Getenv)
	}
	return &museDescriptor{
		home:           home,
		acpBinary:      cfg.AcpBinary,
		museBinary:     cfg.MuseBinary,
		workspaceRoots: museWorkspaceRootsFromIndex,
		processRunning: museProcessRunning,
		userHome:       userHome,
		lookPath:       exec.LookPath,
		isExecutable:   isExecutableFile,
		getenv:         os.Getenv,
	}
}

// defaultMuseHome resolves the muse home the way Muse itself does: under
// $XDG_DATA_HOME when set, otherwise ~/.local/share. Verified against a live
// host, which reports "/root/.local/share/muse" as museHome.
func defaultMuseHome(userHome string, getenv func(string) string) string {
	if xdg := getenv("XDG_DATA_HOME"); xdg != "" {
		return filepath.Join(xdg, "muse")
	}
	base := userHome
	if base == "" {
		base = "."
	}
	return filepath.Join(base, ".local", "share", "muse")
}

// Harness returns the harness identifier.
func (m *museDescriptor) Harness() string { return "muse" }

// museWorkspaceKey derives a stable station key from a workspace path.
// Uses the first 4 bytes (8 hex chars) of SHA256(path) for brevity.
func museWorkspaceKey(wsPath string) string {
	h := sha256.Sum256([]byte(wsPath))
	return fmt.Sprintf("muse:%x", h[:4])
}

// sessionIndexPath returns the path to the session index database.
func (m *museDescriptor) sessionIndexPath() string {
	return filepath.Join(m.home, "session-index.db")
}

// locator resolves the adapter and the muse CLI.
func (m *museDescriptor) locator() binaryLocator {
	return binaryLocator{
		userHome:     m.userHome,
		lookPath:     m.lookPath,
		isExecutable: m.isExecutable,
	}
}

func (m *museDescriptor) acpAdapter() (string, bool) {
	return m.locator().locate(museACPBinaryName, m.acpBinary)
}

func (m *museDescriptor) museCLI() (string, bool) {
	return m.locator().locate(museBinaryName, m.museBinary)
}

// Detect discovers leaf stations, one per distinct workspace Muse has run in.
//
// A missing home is not an error — it means Muse has never run here. An index
// that exists but cannot be read IS an error: a host with Muse installed and no
// sqlite3 would otherwise report no stations and no reason, which is the shape
// of bug that takes an afternoon to find.
func (m *museDescriptor) Detect() ([]Station, error) {
	if _, err := os.Stat(m.home); err != nil {
		if os.IsNotExist(err) {
			return []Station{}, nil
		}
		return nil, fmt.Errorf("muse: reading %s: %w", m.home, err)
	}

	roots, err := m.workspaceRoots(m.sessionIndexPath())
	if err != nil {
		return nil, err
	}

	// "acp" is advertised ONLY when BOTH halves of the chat path resolve: the
	// muse-acp adapter, and the muse binary it drives. The console gates the
	// Chat tab on this capability alone, so advertising it with half a chain
	// buys every station a tab that fails the moment it is clicked — the
	// 2026-08-12 lesson from Pi, where exactly that shipped.
	//
	// Resolved once here rather than per station: both are properties of the
	// node, not of the workspace.
	caps := []string{"skills.inventory", "health", "logs", "fs.read", "fs.write", "terminal", "cleanup"}
	if _, ok := m.acpAdapter(); ok {
		if _, ok := m.museCLI(); ok {
			caps = append(caps, "acp")
		}
	}

	stations := []Station{}
	seen := map[string]bool{}
	for _, wsPath := range roots {
		// A relative root cannot be a workspace: it would resolve against the
		// SERVICE's cwd, and that resolution becomes the fs.read root and the
		// CleanApply root. Muse records absolute paths; anything else is a
		// hand-edited index we refuse rather than guess at.
		if !filepath.IsAbs(wsPath) {
			continue
		}
		if seen[wsPath] {
			continue
		}
		// Only "it is gone" drops a station. A transient stat failure (EACCES
		// on a briefly-unavailable mount, say) must not make a station blink
		// out of the fleet view — same rule as codex and claude-code.
		if _, err := os.Stat(wsPath); os.IsNotExist(err) {
			continue
		}
		seen[wsPath] = true
		wsCopy := wsPath
		stations = append(stations, Station{
			Key:           museWorkspaceKey(wsPath),
			Harness:       "muse",
			Kind:          "leaf",
			DisplayName:   filepath.Base(wsPath),
			ParentKey:     nil,
			WorkspacePath: &wsCopy,
			Capabilities:  AppendChangesetCap(caps, &wsCopy),
		})
	}
	return stations, nil
}

// museWorkspaceRootsFromIndex reads workspace roots from session-index.db via
// the sqlite3 CLI, newest session first.
//
// The sqlite3 CLI rather than a driver dependency: opencode already reads its
// own database this way, and adding a SQLite driver to the node-agent for one
// column is not a trade worth making. An absent database means Muse has not
// recorded a session yet, which is not a failure.
func museWorkspaceRootsFromIndex(dbPath string) ([]string, error) {
	if _, err := os.Stat(dbPath); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("muse: reading %s: %w", dbPath, err)
	}

	cmd := exec.Command("sqlite3", "-readonly", dbPath,
		"SELECT DISTINCT workspace_root FROM sessions WHERE workspace_root IS NOT NULL AND workspace_root != ''")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("muse: reading the session index at %s failed (is sqlite3 installed?): %w", dbPath, err)
	}

	var roots []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line != "" && line != "/" {
			roots = append(roots, line)
		}
	}
	return roots, nil
}

// workspacePathForKey resolves a station key back to its workspace path by
// re-running Detect and filtering by key.
func (m *museDescriptor) workspacePathForKey(key string) (string, error) {
	stations, err := m.Detect()
	if err != nil {
		return "", err
	}
	for _, s := range stations {
		if s.Key == key && s.WorkspacePath != nil {
			return *s.WorkspacePath, nil
		}
	}
	return "", fmt.Errorf("muse: station not found: %q", key)
}

// ACPCommand spawns muse-acp in the station's workspace.
//
// The adapter starts one long-lived `muse serve` and translates ACP to MSP for
// the life of the session, so the only thing it needs from us is which muse to
// drive — MUSE_CLI — and where to drive it.
func (m *museDescriptor) ACPCommand(key string) ([]string, string, []string, error) {
	// The station must exist before anything is probed on the host: an unknown
	// key has no workspace to run in.
	wsPath, err := m.workspacePathForKey(key)
	if err != nil {
		return nil, "", nil, err
	}

	adapter, ok := m.acpAdapter()
	if !ok {
		return nil, "", nil, fmt.Errorf(
			"muse: %s not found; install it (see https://github.com/BrokkAi/muse-acp) or set its path in the node's muse configuration",
			museACPBinaryName)
	}

	// Named explicitly even though the adapter defaults to "muse" on PATH: the
	// node detected these stations from one specific muse home, and the muse on
	// the service's PATH is not guaranteed to be the one that wrote it.
	museCLI, ok := m.museCLI()
	if !ok {
		return nil, "", nil, fmt.Errorf(
			"muse: the %s CLI was not found; %s cannot start a session without it",
			museBinaryName, museACPBinaryName)
	}

	env := []string{museCLIEnv + "=" + museCLI}
	return []string{adapter}, wsPath, env, nil
}

// Health reports on a station by key.
func (m *museDescriptor) Health(key string) (Health, error) {
	wsPath, err := m.workspacePathForKey(key)
	if err != nil {
		return Health{}, err
	}
	return m.healthAt(wsPath), nil
}

// HealthFor implements HealthForStation: it reads the workspace off the station
// the caller already detected instead of re-running Detect to find it again,
// which is what turns a health sweep from O(N²) host scans into O(N).
func (m *museDescriptor) HealthFor(s Station) (Health, error) {
	if s.WorkspacePath == nil || *s.WorkspacePath == "" {
		return m.Health(s.Key)
	}
	return m.healthAt(*s.WorkspacePath), nil
}

// healthAt is the shared body of Health and HealthFor, keyed on a workspace
// path the caller has already resolved.
func (m *museDescriptor) healthAt(wsPath string) Health {
	health := Health{}

	// Disk usage from the shared async cache — never walk on the request path
	// (a node_modules-laden workspace walk can exceed the hub's timeout).
	health.DiskBytes = diskUsage(wsPath)

	running, note := m.processRunning(wsPath)
	health.Running = running
	if note != "" {
		health.Note = &note
	}
	return health
}

// museProcessRunning reports whether a muse process is running with its working
// directory inside wsPath. Always best-effort — see processRunningInWorkspace.
func museProcessRunning(wsPath string) (running bool, note string) {
	return processRunningInWorkspace("^muse", wsPath)
}

// ListDir lists the directory at rel within the station's workspace.
// Paths that escape the workspace via ".." are rejected.
func (m *museDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	wsPath, err := m.workspacePathForKey(key)
	if err != nil {
		return nil, err
	}

	target, err := safeJoin(wsPath, rel)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, fmt.Errorf("muse: ListDir %q: %w", target, err)
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

// ReadFile reads up to maxBytes from rel within the station's workspace.
func (m *museDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	wsPath, err := m.workspacePathForKey(key)
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
		return nil, "", false, fmt.Errorf("muse: ReadFile %q: %w", target, err)
	}
	defer f.Close()

	// One byte past the limit, so a file exactly at the limit is not reported
	// truncated. The encoding hint is left empty, as every other descriptor
	// leaves it: the hub decides how to present the bytes.
	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, "", false, fmt.Errorf("muse: ReadFile read %q: %w", target, err)
	}

	truncated := int64(n) > maxBytes
	if truncated {
		n = int(maxBytes)
	}
	return buf[:n], "", truncated, nil
}

// CleanPlan proposes the reclaimable directories in a Muse workspace.
func (m *museDescriptor) CleanPlan(key string) ([]CleanItem, error) {
	wsPath, err := m.workspacePathForKey(key)
	if err != nil {
		return nil, err
	}
	return cleanPlanCommon(wsPath, []string{".cache", "tmp"})
}

// CleanApply removes the paths the operator chose from a plan.
func (m *museDescriptor) CleanApply(key string, paths []string) (int64, error) {
	wsPath, err := m.workspacePathForKey(key)
	if err != nil {
		return 0, err
	}
	plan, err := m.CleanPlan(key)
	if err != nil {
		return 0, err
	}
	return cleanApplyCommon(wsPath, paths, plan)
}

// TailLogs streams this host's Muse session transcripts.
//
// Sessions are bucketed by date rather than by workspace
// (sessions/<yyyy>/<mm>/<dd>/<session-id>/session.jsonl), exactly as codex
// buckets its rollouts, so this tails the host's recent sessions rather than
// only the ones belonging to this station. The key is still resolved first, so
// an unknown station is refused rather than served another station's logs.
func (m *museDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	if _, err := m.workspacePathForKey(key); err != nil {
		return err
	}

	collect := func() []string { return collectMuseLogFiles(filepath.Join(m.home, "sessions")) }
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

// museRecentLogFiles bounds how many session transcripts a tail follows, newest
// first. A long-lived host accumulates a session directory per run; following
// all of them would open an unbounded number of files for a single log view.
const museRecentLogFiles = 20

// collectMuseLogFiles returns the newest session transcripts under sessDir,
// newest first. A missing directory yields nothing rather than an error: a host
// where Muse has started but not yet completed a session has no transcripts.
func collectMuseLogFiles(sessDir string) []string {
	var files []string
	// sessions/<yyyy>/<mm>/<dd>/<session-id>/session.jsonl
	matches, err := filepath.Glob(filepath.Join(sessDir, "*", "*", "*", "*", "session.jsonl"))
	if err != nil {
		return nil
	}
	files = append(files, matches...)

	type stamped struct {
		path string
		mod  time.Time
	}
	stamps := make([]stamped, 0, len(files))
	for _, f := range files {
		info, err := os.Stat(f)
		if err != nil {
			continue
		}
		stamps = append(stamps, stamped{path: f, mod: info.ModTime()})
	}
	sort.Slice(stamps, func(i, j int) bool { return stamps[i].mod.After(stamps[j].mod) })

	out := make([]string, 0, len(stamps))
	for i, s := range stamps {
		if i >= museRecentLogFiles {
			break
		}
		out = append(out, s.path)
	}
	return out
}
