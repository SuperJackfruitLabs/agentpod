package descriptor

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

// --- Descriptor surface implemented in a later task ---
//
// Health, ListDir, ReadFile and TailLogs land with the rest of the station
// capabilities; they are stubbed here only so piDescriptor satisfies
// Descriptor. Detect does not advertise a capability these would serve before
// they are real.

func (p *piDescriptor) Health(key string) (Health, error) {
	return Health{}, fmt.Errorf("pi: health %q: not implemented", key)
}

func (p *piDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	return nil, fmt.Errorf("pi: ListDir %q: not implemented", key)
}

func (p *piDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	return nil, "", false, fmt.Errorf("pi: ReadFile %q: not implemented", key)
}

func (p *piDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	return fmt.Errorf("pi: TailLogs %q: not implemented", key)
}
