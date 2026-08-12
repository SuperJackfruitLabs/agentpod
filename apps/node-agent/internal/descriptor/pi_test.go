package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// buildPiFixture creates <tmp>/sessions/<encoded>/<ts>_<uuid>.jsonl files whose
// first line carries the workspace path verbatim, plus a session dir with no
// jsonl at all (observed live: `pi --mode rpc` creates the dir without a session).
func buildPiFixture(t *testing.T) (dataDir string, wsHyphen string) {
	t.Helper()
	root := t.TempDir()
	dataDir = filepath.Join(root, "agent")

	// A real workspace whose name CONTAINS A HYPHEN. Decoding the directory
	// name would yield ".../idea/bank", which does not exist — the station
	// would vanish silently. This is the case that forces header parsing.
	wsHyphen = filepath.Join(root, "Projects", "idea-bank")
	if err := os.MkdirAll(wsHyphen, 0o755); err != nil {
		t.Fatal(err)
	}
	writePiSession(t, dataDir, "--"+strings.ReplaceAll(strings.TrimPrefix(wsHyphen, "/"), "/", "-")+"--", wsHyphen)

	// A session dir with NO jsonl — must be skipped, never guessed at.
	if err := os.MkdirAll(filepath.Join(dataDir, "sessions", "--private-tmp--"), 0o755); err != nil {
		t.Fatal(err)
	}

	// A session whose workspace no longer exists — must be filtered out.
	writePiSession(t, dataDir, "--gone--", filepath.Join(root, "deleted"))
	return dataDir, wsHyphen
}

func writePiSession(t *testing.T, dataDir, encoded, cwd string) {
	t.Helper()
	dir := filepath.Join(dataDir, "sessions", encoded)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	header := fmt.Sprintf(`{"type":"session","version":3,"id":"x","timestamp":"2026-08-12T08:10:23.796Z","cwd":%q}`, cwd)
	if err := os.WriteFile(filepath.Join(dir, "2026-08-12T08-10-23-796Z_uuid.jsonl"), []byte(header+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPiDetectReadsWorkspaceFromSessionHeader(t *testing.T) {
	dataDir, wsHyphen := buildPiFixture(t)
	stations, err := NewPi(dataDir).Detect()
	if err != nil {
		t.Fatal(err)
	}
	if len(stations) != 1 {
		t.Fatalf("want 1 station, got %d: %+v", len(stations), stations)
	}
	s := stations[0]
	if s.WorkspacePath == nil || *s.WorkspacePath != wsHyphen {
		t.Errorf("workspace = %v, want %s (a hyphenated path must survive)", s.WorkspacePath, wsHyphen)
	}
	if s.Harness != "pi" {
		t.Errorf("harness = %q, want pi", s.Harness)
	}
	if s.Key != piProjectKey(wsHyphen) {
		t.Errorf("key = %q", s.Key)
	}
}

func TestPiDetectMissingDataDirReturnsEmpty(t *testing.T) {
	stations, err := NewPi(filepath.Join(t.TempDir(), "nope")).Detect()
	if err != nil {
		t.Fatalf("missing data dir must not error: %v", err)
	}
	if len(stations) != 0 {
		t.Errorf("want empty, got %+v", stations)
	}
}
