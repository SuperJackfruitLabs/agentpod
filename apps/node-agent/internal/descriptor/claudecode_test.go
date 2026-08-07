package descriptor

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// buildClaudeCodeFixture creates a temporary Claude Code home and project
// directories suitable for testing. It returns the home (~/.claude) path and
// the json directory (~/ where .claude.json lives). t.Cleanup removes the
// temp tree automatically.
func buildClaudeCodeFixture(t *testing.T) (home, jsonDir string, projA, projB string) {
	t.Helper()

	root := t.TempDir()

	// Create project directories with at least one file each.
	projA = filepath.Join(root, "proj-a")
	projB = filepath.Join(root, "proj-b")
	for _, d := range []string{projA, projB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("MkdirAll %s: %v", d, err)
		}
	}
	if err := os.WriteFile(filepath.Join(projA, "hello.txt"), []byte("project a content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projB, "world.txt"), []byte("project b content\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Create session directories using the sanitised path (/ → -).
	home = filepath.Join(root, ".claude")
	jsonDir = root

	sanitize := func(p string) string { return strings.ReplaceAll(p, "/", "-") }

	for _, p := range []string{projA, projB} {
		sessDir := filepath.Join(home, "projects", sanitize(p))
		if err := os.MkdirAll(sessDir, 0o755); err != nil {
			t.Fatalf("MkdirAll session dir %s: %v", sessDir, err)
		}
		jsonl := fmt.Sprintf(`{"type":"user","text":"hello from %s"}`+"\n", filepath.Base(p))
		if err := os.WriteFile(filepath.Join(sessDir, "session.jsonl"), []byte(jsonl), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// Write .claude.json with both project paths as keys.
	claudeJSON := map[string]interface{}{
		"projects": map[string]interface{}{
			projA: map[string]interface{}{},
			projB: map[string]interface{}{},
		},
	}
	data, err := json.Marshal(claudeJSON)
	if err != nil {
		t.Fatalf("marshal .claude.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(jsonDir, ".claude.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	return home, jsonDir, projA, projB
}

// expectedClaudeKey computes the station key for a project path, mirroring
// the production implementation so tests can assert exact keys.
func expectedClaudeKey(projPath string) string {
	h := sha256.Sum256([]byte(projPath))
	return fmt.Sprintf("claude-code:%x", h[:4])
}

// --- Detect ---

func TestClaudeCodeDetect_ReturnsTwoLeafStations(t *testing.T) {
	home, _, projA, projB := buildClaudeCodeFixture(t)
	d := NewClaudeCode(home)

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	if len(stations) != 2 {
		t.Fatalf("expected 2 leaf stations, got %d: %+v", len(stations), stations)
	}

	// Index by key.
	byKey := make(map[string]Station, len(stations))
	for _, s := range stations {
		byKey[s.Key] = s
	}

	for _, projPath := range []string{projA, projB} {
		key := expectedClaudeKey(projPath)
		s, ok := byKey[key]
		if !ok {
			t.Errorf("station for project %s (key %s) not found", projPath, key)
			continue
		}
		if s.Harness != "claude-code" {
			t.Errorf("%s harness: want claude-code, got %s", key, s.Harness)
		}
		if s.Kind != "leaf" {
			t.Errorf("%s kind: want leaf, got %s", key, s.Kind)
		}
		if s.ParentKey != nil {
			t.Errorf("%s parentKey: want nil, got %v", key, s.ParentKey)
		}
		if s.WorkspacePath == nil || *s.WorkspacePath != projPath {
			t.Errorf("%s workspacePath: want %s, got %v", key, projPath, s.WorkspacePath)
		}
		if s.DisplayName != filepath.Base(projPath) {
			t.Errorf("%s displayName: want %s, got %s", key, filepath.Base(projPath), s.DisplayName)
		}
		caps := map[string]bool{}
		for _, c := range s.Capabilities {
			caps[c] = true
		}
		for _, want := range []string{"health", "logs", "fs.read"} {
			if !caps[want] {
				t.Errorf("%s missing capability %q", key, want)
			}
		}
	}
}

func TestClaudeCodeDetect_MissingHomeReturnsEmpty(t *testing.T) {
	d := NewClaudeCode("/nonexistent/claude/home/path")
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect on missing home: %v", err)
	}
	if len(stations) != 0 {
		t.Fatalf("expected empty stations, got %d", len(stations))
	}
}

func TestClaudeCodeDetect_NonexistentProjectSkipped(t *testing.T) {
	home, jsonDir, projA, _ := buildClaudeCodeFixture(t)

	// Add a third path that doesn't exist.
	ghost := filepath.Join(filepath.Dir(projA), "proj-ghost")

	// Rewrite .claude.json with the ghost path.
	claudeJSON := map[string]interface{}{
		"projects": map[string]interface{}{
			projA:  map[string]interface{}{},
			ghost:  map[string]interface{}{},
		},
	}
	data, _ := json.Marshal(claudeJSON)
	_ = os.WriteFile(filepath.Join(jsonDir, ".claude.json"), data, 0o644)

	d := NewClaudeCode(home)
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	for _, s := range stations {
		if s.WorkspacePath != nil && *s.WorkspacePath == ghost {
			t.Errorf("ghost project should have been filtered out: %+v", s)
		}
	}
}

// --- ListDir ---

func TestClaudeCodeListDir_ProjectDir(t *testing.T) {
	home, _, projA, _ := buildClaudeCodeFixture(t)
	d := NewClaudeCode(home)

	key := expectedClaudeKey(projA)
	entries, err := d.ListDir(key, "")
	if err != nil {
		t.Fatalf("ListDir: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least one entry")
	}
	var found bool
	for _, e := range entries {
		if e.Name == "hello.txt" {
			found = true
		}
	}
	if !found {
		t.Errorf("hello.txt not found in entries: %+v", entries)
	}
}

func TestClaudeCodeListDir_DotDotEscape(t *testing.T) {
	home, _, projA, _ := buildClaudeCodeFixture(t)
	d := NewClaudeCode(home)

	key := expectedClaudeKey(projA)
	_, err := d.ListDir(key, "../../../etc")
	if err == nil {
		t.Fatal("expected error for .. escape")
	}
}

// --- ReadFile ---

func TestClaudeCodeReadFile_ReadsContent(t *testing.T) {
	home, _, projA, _ := buildClaudeCodeFixture(t)
	d := NewClaudeCode(home)

	key := expectedClaudeKey(projA)
	content, _, truncated, err := d.ReadFile(key, "hello.txt", 0)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if truncated {
		t.Error("expected not truncated for small file")
	}
	if !strings.Contains(string(content), "project a") {
		t.Errorf("content should contain 'project a', got: %s", content)
	}
}

func TestClaudeCodeReadFile_Truncation(t *testing.T) {
	home, _, projA, _ := buildClaudeCodeFixture(t)
	d := NewClaudeCode(home)

	key := expectedClaudeKey(projA)
	content, _, truncated, err := d.ReadFile(key, "hello.txt", 5)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !truncated {
		t.Error("expected truncated=true when maxBytes < file size")
	}
	if len(content) != 5 {
		t.Errorf("expected 5 bytes, got %d", len(content))
	}
}

func TestClaudeCodeReadFile_DotDotEscape(t *testing.T) {
	home, _, projA, _ := buildClaudeCodeFixture(t)
	d := NewClaudeCode(home)

	key := expectedClaudeKey(projA)
	_, _, _, err := d.ReadFile(key, "../proj-b/world.txt", 0)
	if err == nil {
		t.Fatal("expected error for .. escape")
	}
}

// --- Health ---

func TestClaudeCodeHealth_ReturnsDiskBytes(t *testing.T) {
	home, _, projA, _ := buildClaudeCodeFixture(t)
	d := NewClaudeCode(home)

	key := expectedClaudeKey(projA)
	// DiskBytes populates asynchronously (cached background walk).
	disk := waitForHealthDiskBytes(t, func() (Health, error) { return d.Health(key) })
	if disk < 0 {
		t.Errorf("DiskBytes should be >= 0, got %d", disk)
	}
	h, err := d.Health(key)
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	// Running is best-effort; just ensure no panic.
	_ = h.Running
}

func TestClaudeCodeHealth_LastActivitySet(t *testing.T) {
	home, _, projA, _ := buildClaudeCodeFixture(t)
	d := NewClaudeCode(home)

	key := expectedClaudeKey(projA)
	h, err := d.Health(key)
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	// Session files exist, so LastActivity should be populated.
	if h.LastActivity == nil || *h.LastActivity == "" {
		t.Error("expected LastActivity to be set when session files exist")
	}
}

// --- TailLogs ---

func TestClaudeCodeTailLogs_EmitsSessionJsonl(t *testing.T) {
	home, _, projA, _ := buildClaudeCodeFixture(t)
	d := NewClaudeCode(home)

	key := expectedClaudeKey(projA)
	var chunks [][]byte
	err := d.TailLogs(context.Background(), key, false, func(b []byte) error {
		chunks = append(chunks, b)
		return nil
	})
	if err != nil {
		t.Fatalf("TailLogs: %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least one chunk")
	}
	var all string
	for _, c := range chunks {
		all += string(c)
	}
	if !strings.Contains(all, "proj-a") {
		t.Errorf("expected session content referencing proj-a, got: %s", all)
	}
}
