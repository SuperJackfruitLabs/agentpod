package descriptor

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// piDescriptor implements Descriptor for the Pi leaf harness
// (@earendil-works/pi-coding-agent).
//
// Pi is a project-workspace harness with NO daemon: it is invoked per command,
// so one install yields one station per workspace and "lifecycle" is never
// advertised. The data-dir layout, read off a real Pi 0.84.1 install on
// 2026-08-12 (see docs/superpowers/specs/2026-08-12-pi-harness-design.md):
//
//	~/.pi/agent/
//	  auth.json           credentials (0600)
//	  models-store.json   cached model catalogs (0600)
//	  settings.json
//	  bin/rg
//	  sessions/
//	    --Users-foo-Projects-research--/   <ts>_<uuid>.jsonl
//	    --private-tmp--/                   (no .jsonl at all)
//
// Key format: "pi:<8-hex-char SHA256 prefix of the workspace path>", the same
// scheme claude-code, codex and opencode use.
//
// Workspace discovery reads the FIRST LINE of a session's *.jsonl file and
// takes its "cwd" field verbatim:
//
//	{"type":"session","version":3,"id":"…","timestamp":"…","cwd":"/Users/foo/Projects/research"}
//
// The sanitised directory name is NEVER decoded. Pi encodes a workspace by
// replacing '/' with '-', so a real project named "idea-bank" becomes
// "--Users-foo-Projects-idea-bank--" and decoding hyphens back to slashes
// yields ".../idea/bank", a path that does not exist — the station would
// disappear silently. That was observed live, not theorised, which is why the
// decode path from opencode.go is deliberately not implemented here: a session
// directory with no readable *.jsonl is SKIPPED rather than guessed at
// (observed: `pi --mode rpc` creates the directory without writing a session).
type piDescriptor struct {
	dataDir    string // absolute path to ~/.pi/agent
	sessionDir string // absolute path to the sessions directory
}

const (
	// piDataDirEnv overrides the default Pi data directory.
	piDataDirEnv = "PI_CODING_AGENT_DIR"

	// piSessionDirEnv overrides the session directory independently of the
	// data directory. Pi also allows --session-dir and a "sessionDir" key in
	// settings.json; neither is read here, so a machine that moved its session
	// directory through settings.json under-reports. That is accepted and
	// documented rather than guessed at.
	piSessionDirEnv = "PI_CODING_AGENT_SESSION_DIR"

	// piBinaryEnv names the Pi executable explicitly, mirroring CODEX_PATH in
	// codex.go. It exists because Pi is an npm package and the npm prefix is
	// frequently user-local: on the fleet host `superchotu` (observed
	// 2026-08-12) `pi` resolves to /home/openclaw/.npm-global/bin/pi, not to
	// /usr/local or /opt/homebrew. Hardcoding a location would miss it, and a
	// node-agent running as a service may have a PATH that misses it too.
	piBinaryEnv = "PI_PATH"

	// piDebugLogName is Pi's ONLY log file, and it lives beside the data dir
	// rather than under a station: it is global, not per-workspace. It is also
	// written only when the hidden /debug command is enabled, so on nearly
	// every real station it does not exist at all.
	piDebugLogName = "pi-debug.log"
)

// NewPi returns a Descriptor for the Pi harness.
//
// dataDir is the path to the Pi agent directory. An explicit value wins over
// everything: it means "all of Pi's state lives here" and neither environment
// override applies. When it is empty the default is PI_CODING_AGENT_DIR, or
// $HOME/.pi/agent, with PI_CODING_AGENT_SESSION_DIR overriding the sessions
// directory alone.
func NewPi(dataDir string) Descriptor {
	p := &piDescriptor{dataDir: dataDir}
	if dataDir == "" {
		p.dataDir = piDefaultDataDir()
		p.sessionDir = os.Getenv(piSessionDirEnv)
	}
	if p.sessionDir == "" {
		p.sessionDir = filepath.Join(p.dataDir, "sessions")
	}
	return p
}

// piDefaultDataDir returns PI_CODING_AGENT_DIR when set, else $HOME/.pi/agent.
func piDefaultDataDir() string {
	if dir := os.Getenv(piDataDirEnv); dir != "" {
		return dir
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		userHome = "."
	}
	return filepath.Join(userHome, ".pi", "agent")
}

// Harness returns the harness identifier. It MUST equal the RuntimeHarness
// enum value, or auto-adoption (which matches on harness string equality)
// silently fails to match a provisioned runtime to its detected station.
func (p *piDescriptor) Harness() string { return "pi" }

// piProjectKey derives a stable station key from a workspace path.
// Uses the first 4 bytes (8 hex chars) of SHA256(path), mirroring
// openCodeProjectKey. The key is the hub's primary identity for a station and
// cannot be changed after adoption.
func piProjectKey(workspacePath string) string {
	h := sha256.Sum256([]byte(workspacePath))
	return fmt.Sprintf("pi:%x", h[:4])
}

// Detect discovers leaf stations for Pi, one per workspace.
//
// It enumerates <sessionDir>/*/ and reads each session's workspace path from
// the first line of a *.jsonl file. Directories with no readable session file
// are skipped; workspaces that no longer exist are filtered out; and resolved
// paths are deduplicated through filepath.EvalSymlinks because Pi stores the
// RESOLVED path (/tmp is recorded as /private/tmp).
//
// A missing data/session directory is not an error — it just means Pi has
// never run here.
func (p *piDescriptor) Detect() ([]Station, error) {
	entries, err := os.ReadDir(p.sessionDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Station{}, nil
		}
		return nil, fmt.Errorf("pi: listing %s: %w", p.sessionDir, err)
	}

	// "lifecycle" is NEVER advertised: Pi has no persistent process to stop or
	// start, so this descriptor does not implement Lifecycle at all.
	caps := []string{"health", "logs", "fs.read", "fs.write", "terminal", "cleanup"}

	seen := make(map[string]bool)
	stations := []Station{}

	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		wsPath, ok := piWorkspaceFromSessionDir(filepath.Join(p.sessionDir, e.Name()))
		if !ok {
			continue // no readable session header — skip, never guess
		}
		if _, err := os.Stat(wsPath); err != nil {
			continue // workspace deleted (or unreadable)
		}
		resolved, err := filepath.EvalSymlinks(wsPath)
		if err != nil {
			resolved = wsPath
		}
		if seen[resolved] {
			continue
		}
		seen[resolved] = true

		wsCopy := wsPath
		stations = append(stations, Station{
			Key:           piProjectKey(wsPath),
			Harness:       "pi",
			Kind:          "leaf",
			DisplayName:   filepath.Base(wsPath),
			ParentKey:     nil,
			WorkspacePath: &wsCopy,
			Capabilities:  AppendChangesetCap(caps, &wsCopy),
			MatrixId:      nil,
		})
	}

	return stations, nil
}

// piSessionHeader is the first line of a Pi session transcript. Only "cwd"
// matters here, and it carries the workspace path verbatim.
type piSessionHeader struct {
	Type string `json:"type"`
	Cwd  string `json:"cwd"`
}

// piHeaderMaxBytes bounds the first-line read. A session header is a short
// single line; anything larger is not one, and reading it whole would let a
// malformed transcript pull megabytes into memory during detection.
const piHeaderMaxBytes = 1 << 20 // 1 MiB

// piWorkspaceFromSessionDir returns the workspace path recorded in the first
// line of a *.jsonl file inside dir. Files are tried in directory order until
// one yields a non-empty "cwd"; ok is false when none does.
func piWorkspaceFromSessionDir(dir string) (string, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".jsonl") {
			continue
		}
		if cwd, ok := piCwdFromSessionFile(filepath.Join(dir, e.Name())); ok {
			return cwd, true
		}
	}
	return "", false
}

// piCwdFromSessionFile reads the first line of path and returns its "cwd".
func piCwdFromSessionFile(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), piHeaderMaxBytes)
	if !scanner.Scan() {
		return "", false // empty file
	}
	var header piSessionHeader
	if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
		return "", false
	}
	if header.Cwd == "" {
		return "", false
	}
	return header.Cwd, true
}

// resolveKey maps a station key back to its workspace path and the session
// directories recorded against it.
//
// Resolution re-reads the session headers rather than caching Detect's output:
// the same source of truth, so a key can never resolve to a workspace Detect
// would not have produced. Session directories are returned as a slice because
// Pi writes one per workspace *string*, and two of them can name the same
// workspace (Detect dedupes those through EvalSymlinks); LastActivity should
// see every transcript belonging to the station.
//
// Unlike Detect, a workspace that no longer exists is NOT filtered out here.
// Detect already keeps such keys from ever reaching the hub, and letting the
// underlying os call report "no such file" is a clearer failure than a
// station-not-found for a station the caller can see.
func (p *piDescriptor) resolveKey(key string) (wsPath string, sessionDirs []string, err error) {
	entries, err := os.ReadDir(p.sessionDir)
	if err != nil && !os.IsNotExist(err) {
		return "", nil, fmt.Errorf("pi: listing %s: %w", p.sessionDir, err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(p.sessionDir, e.Name())
		cwd, ok := piWorkspaceFromSessionDir(dir)
		if !ok || piProjectKey(cwd) != key {
			continue
		}
		wsPath = cwd
		sessionDirs = append(sessionDirs, dir)
	}
	if wsPath == "" {
		return "", nil, fmt.Errorf("pi: station not found: %q", key)
	}
	return wsPath, sessionDirs, nil
}

// workspaceForKey returns just the workspace path for a station key.
func (p *piDescriptor) workspaceForKey(key string) (string, error) {
	wsPath, _, err := p.resolveKey(key)
	return wsPath, err
}

// Health returns a best-effort liveness/resource snapshot for a Pi station.
//
// Running is normally FALSE and that is correct, not a fault: Pi has no
// daemon. It is invoked per command, so a station with nobody currently
// talking to it has no process at all. Health therefore never treats the
// absence of a process as an error, and never sets a note for it.
func (p *piDescriptor) Health(key string) (Health, error) {
	wsPath, sessionDirs, err := p.resolveKey(key)
	if err != nil {
		return Health{}, err
	}

	health := Health{}

	// Disk usage from the shared async cache — never walk on the request path
	// (a node_modules-laden workspace walk can exceed the hub's timeout).
	health.DiskBytes = diskUsage(wsPath)

	running, note := piProcessRunning()
	health.Running = running
	if note != "" {
		health.Note = &note
	}

	// LastActivity: newest transcript mtime across the station's session dirs.
	var newest time.Time
	for _, dir := range sessionDirs {
		if t := newestMtime(dir); t.After(newest) {
			newest = t
		}
	}
	if !newest.IsZero() {
		s := newest.UTC().Format(time.RFC3339)
		health.LastActivity = &s
	}

	return health, nil
}

// piEntryPaths returns the absolute paths a running Pi would carry in its
// command line: the resolved `pi` executable, plus the symlink target when it
// differs (npm installs `bin/pi` as a symlink to the package's dist/cli.js, and
// which one lands in argv depends on how Pi was launched).
//
// Resolution order: PI_PATH, then `pi` on PATH. Nothing is hardcoded — the npm
// prefix is routinely user-local (see piBinaryEnv).
func piEntryPaths() []string {
	path := os.Getenv(piBinaryEnv)
	if path == "" {
		resolved, err := exec.LookPath("pi")
		if err != nil {
			return nil
		}
		path = resolved
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	paths := []string{abs}
	if real, err := filepath.EvalSymlinks(abs); err == nil && real != abs {
		paths = append(paths, real)
	}
	return paths
}

// piProcessPattern builds the pgrep -f pattern that matches a live
// `pi --mode rpc` process, and nothing else.
//
// Three properties, each paid for by a bug:
//
//  1. It matches on the RESOLVED ABSOLUTE PATH, never the bare word "pi",
//     which occurs inside countless unrelated command lines.
//
//  2. It requires "--mode rpc" as well. `pgrep -x pi` cannot substitute:
//     measured on macOS and on Linux (superchotu, 2026-08-12), Pi's `comm` is
//     "node" — process.title = "pi" does not rewrite comm — so -x matches
//     nothing and only -f can see the arguments.
//
//  3. It is ANCHORED, and allows the path only as the first or second token
//     (the second covers the `node <pi> --mode rpc` form the shebang produces;
//     comm is node, so that is the usual shape). This is what defeats the
//     self-match hazard: `pgrep -f "dist/cli.js"` was observed matching the
//     very shell that ran it, because that shell's own command line contained
//     the pattern text. Any process that merely MENTIONS the Pi path — a pgrep
//     caller, a grep, an editor, a debugging shell — carries it several tokens
//     deep, past the anchor, so it cannot match. The same class of bug twice
//     broke opencode health, where the broad "opencode" pattern matched
//     docker-init's own cmdline and health could never report stopped.
//
// The cost is a false negative if Pi is ever launched under an interpreter
// bearing its own flags (`node --flag <pi> --mode rpc`). That is the cheap
// direction to be wrong for a daemonless harness whose resting state is
// already "not running" — the expensive direction is reporting a station busy
// when nothing is there.
//
// ok is false when no Pi executable can be resolved at all, which is not a
// pattern this function may guess at.
func piProcessPattern() (pattern string, ok bool) {
	paths := piEntryPaths()
	if len(paths) == 0 {
		return "", false
	}
	quoted := make([]string, 0, len(paths))
	for _, path := range paths {
		// QuoteMeta's escapes (\. \+ \* \? \( \) \| \[ \] \{ \} \^ \$) are all
		// valid POSIX ERE, which is the dialect pgrep compiles.
		quoted = append(quoted, regexp.QuoteMeta(path))
	}
	// ^[optional interpreter token] <pi path> <anything> --mode rpc
	return "^([^[:space:]]+[[:space:]]+)?(" + strings.Join(quoted, "|") +
		")[[:space:]].*--mode[[:space:]=]+rpc", true
}

// piProcessRunning reports whether a `pi --mode rpc` process is alive.
//
// Best-effort by design. pgrep exiting 1 means "no match", which for Pi is the
// ordinary resting state, so it returns false with NO note. A note is reserved
// for the cases where the check genuinely could not run — pgrep missing, or no
// Pi executable to build a safe pattern from.
func piProcessRunning() (running bool, note string) {
	pattern, ok := piProcessPattern()
	if !ok {
		return false, "process check unavailable (no pi executable found; set " + piBinaryEnv + ")"
	}
	out, err := exec.Command("pgrep", "-f", pattern).Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return false, "" // no match — normal for a daemonless harness
		}
		return false, "process check unavailable (pgrep not found or failed)"
	}
	return strings.TrimSpace(string(out)) != "", ""
}

// ListDir lists the directory at rel within the station's workspace.
// Paths that escape the workspace via ".." are rejected.
func (p *piDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	wsPath, err := p.workspaceForKey(key)
	if err != nil {
		return nil, err
	}

	target, err := safeJoin(wsPath, rel)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, fmt.Errorf("pi: ListDir %q: %w", target, err)
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
// maxBytes+1 bytes are requested so that a file exactly filling the budget is
// distinguishable from one that overflows it.
func (p *piDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	wsPath, err := p.workspaceForKey(key)
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
		return nil, "", false, fmt.Errorf("pi: ReadFile %q: %w", target, err)
	}
	defer f.Close()

	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, "", false, fmt.Errorf("pi: ReadFile read %q: %w", target, err)
	}

	truncated := int64(n) > maxBytes
	if truncated {
		n = int(maxBytes)
	}
	return buf[:n], "", truncated, nil
}

// TailLogs emits <dataDir>/pi-debug.log, Pi's single global log file.
//
// The file is usually ABSENT (it is written only with the hidden /debug
// enabled), which makes Pi the worst case for the 2026-08-09 dogfooding bug:
// follow mode with zero log files returned immediately, the hub closed the
// SSE, and the console's Logs tab retry-looped into "Disconnected". Follow mode
// therefore blocks in waitForLogFiles until the file appears or ctx is done.
// One-shot mode with no file emits nothing and returns nil — not an error.
func (p *piDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	// Validate the key resolves to a known station.
	if _, err := p.workspaceForKey(key); err != nil {
		return err
	}

	logPath := filepath.Join(p.dataDir, piDebugLogName)
	collect := func() []string {
		if info, err := os.Stat(logPath); err == nil && !info.IsDir() {
			return []string{logPath}
		}
		return nil
	}

	if !follow {
		return emitLastNLines(collect(), tailDefaultN, tailMaxBytes, emit)
	}

	logFiles := waitForLogFiles(ctx, collect)
	if err := emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit); err != nil {
		return err
	}

	var offset int64
	if info, err := os.Stat(logPath); err == nil {
		offset = info.Size()
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			n, err := emitLogFileFrom(logPath, offset, emit)
			if err != nil {
				continue
			}
			offset += n
		}
	}
}

// CleanPlan returns the cleanable items for a Pi station.
//
// The candidate-directory list is deliberately EMPTY. Every other descriptor
// names directories (".cache", "tmp", …) that were observed to be caches on a
// real machine; no Pi cache directory has been. A guessed entry here is a path
// the console invites a user to delete, so the list stays empty until an
// observation justifies widening it — the honest plan is the one that offers
// nothing rather than the one that offers a plausible-looking source
// directory. cleanPlanCommon still offers *.log files at the workspace root,
// which is its generic behaviour for all harnesses and not a Pi-specific
// claim.
func (p *piDescriptor) CleanPlan(key string) ([]CleanItem, error) {
	wsPath, err := p.workspaceForKey(key)
	if err != nil {
		return nil, err
	}
	return cleanPlanCommon(wsPath, nil)
}

// CleanApply removes selected cleanable paths from the Pi workspace. Paths are
// re-jailed to the workspace AND intersected with the current plan, so an
// off-plan path is silently skipped rather than removed.
func (p *piDescriptor) CleanApply(key string, paths []string) (int64, error) {
	wsPath, err := p.workspaceForKey(key)
	if err != nil {
		return 0, err
	}
	plan, err := p.CleanPlan(key)
	if err != nil {
		return 0, err
	}
	return cleanApplyCommon(wsPath, paths, plan)
}
