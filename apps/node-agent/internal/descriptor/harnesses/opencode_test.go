package harnesses

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// buildOpenCodeFixture creates a temporary OpenCode data directory suitable for
// testing. Returns the dataDir and the real project path that was registered.
// t.Cleanup removes the temp tree automatically.
//
// Layout created:
//
//	<root>/
//	  project/
//	    global/                           ← must be skipped by Detect
//	    <sanitised real project path>/    ← should appear as a station
//	    <sanitised ghost path>/           ← decoded path doesn't exist → filtered
//	  log/
//	    test.log                          ← sample log content
func buildOpenCodeFixture(t *testing.T) (dataDir, projPath string) {
	t.Helper()

	root := t.TempDir()
	dataDir = filepath.Join(root, "opencode")

	// Create a real project directory with at least one file.
	projPath = filepath.Join(root, "myproject")
	if err := os.MkdirAll(projPath, 0o755); err != nil {
		t.Fatalf("MkdirAll projPath: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Sanitise: strip leading '/', replace '/' with '-'.
	sanitise := func(p string) string {
		return strings.ReplaceAll(strings.TrimPrefix(p, "/"), "/", "-")
	}

	// Create project/ subdirs.
	projsDir := filepath.Join(dataDir, "project")

	// global/ entry — Detect must skip this.
	if err := os.MkdirAll(filepath.Join(projsDir, "global"), 0o755); err != nil {
		t.Fatalf("MkdirAll global: %v", err)
	}

	// Real project entry.
	realSanitised := sanitise(projPath)
	realProjDataDir := filepath.Join(projsDir, realSanitised)
	if err := os.MkdirAll(realProjDataDir, 0o755); err != nil {
		t.Fatalf("MkdirAll real proj data dir: %v", err)
	}
	// Write an activity file so LastActivity is non-nil.
	if err := os.WriteFile(filepath.Join(realProjDataDir, "app.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}

	// Ghost project entry: decoded path will not exist on disk.
	// Use a name that decodes to a nonexistent path.
	ghostSanitised := "nonexistent-ghost-project-abc"
	if err := os.MkdirAll(filepath.Join(projsDir, ghostSanitised), 0o755); err != nil {
		t.Fatalf("MkdirAll ghost proj data dir: %v", err)
	}

	// Create log/ directory with a sample log file.
	logDir := filepath.Join(dataDir, "log")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatalf("MkdirAll logDir: %v", err)
	}
	logContent := "2026-01-01T00:00:00Z info opencode started\n2026-01-01T00:00:01Z info session ready\n"
	if err := os.WriteFile(filepath.Join(logDir, "test.log"), []byte(logContent), 0o644); err != nil {
		t.Fatal(err)
	}

	return dataDir, projPath
}
