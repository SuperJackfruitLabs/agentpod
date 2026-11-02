package harnesses

import (
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
