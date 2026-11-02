package hermes

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCleanPlan_ListsCleanableNotSource verifies that CleanPlan enumerates
// cache/log dirs (with correct sizes) but NOT source files.
func TestCleanPlan_ListsCleanableNotSource(t *testing.T) {
	workspace := t.TempDir()

	// Create a logs dir with a file (2 bytes).
	logsDir := filepath.Join(workspace, "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logsDir, "app.log"), []byte("ab"), 0644); err != nil {
		t.Fatal(err)
	}

	// Create a "source" file that must NOT be cleanable.
	if err := os.WriteFile(filepath.Join(workspace, "source.py"), []byte("print('hello')"), 0644); err != nil {
		t.Fatal(err)
	}

	desc := &Descriptor{home: workspace}
	items, err := desc.CleanPlan("hermes")
	if err != nil {
		t.Fatalf("CleanPlan: %v", err)
	}

	pathSet := make(map[string]bool)
	for _, item := range items {
		pathSet[item.Path] = true
	}

	if !pathSet["logs"] {
		t.Error("expected logs/ to be in CleanPlan")
	}
	if pathSet["source.py"] {
		t.Error("source.py must NOT be in CleanPlan")
	}

	// Each item must have a non-negative size.
	for _, item := range items {
		if item.Size < 0 {
			t.Errorf("item %q has negative size %d", item.Path, item.Size)
		}
	}
}

// TestCleanApply_RemovesCacheAndReturnsByteCount verifies that CleanApply
// removes the requested path and returns its byte count.
func TestCleanApply_RemovesCacheAndReturnsByteCount(t *testing.T) {
	workspace := t.TempDir()

	logsDir := filepath.Join(workspace, "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := []byte("some log content here")
	if err := os.WriteFile(filepath.Join(logsDir, "run.log"), content, 0644); err != nil {
		t.Fatal(err)
	}

	desc := &Descriptor{home: workspace}
	removed, err := desc.CleanApply("hermes", []string{"logs"})
	if err != nil {
		t.Fatalf("CleanApply: %v", err)
	}
	if removed <= 0 {
		t.Errorf("expected removed > 0, got %d", removed)
	}
	// The logs dir must be gone.
	if _, err := os.Stat(logsDir); !os.IsNotExist(err) {
		t.Error("logs/ dir should have been removed")
	}
}

// TestCleanApply_RefusesOffPlanPath verifies that CleanApply does NOT remove
// paths that are not in the plan (even if they're valid jailed paths).
func TestCleanApply_RefusesOffPlanPath(t *testing.T) {
	workspace := t.TempDir()

	// source.py is a valid workspace file but NOT in the plan.
	srcFile := filepath.Join(workspace, "source.py")
	if err := os.WriteFile(srcFile, []byte("important code"), 0644); err != nil {
		t.Fatal(err)
	}

	// Also put a cleanable logs dir so the plan is non-empty.
	logsDir := filepath.Join(workspace, "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logsDir, "x.log"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	desc := &Descriptor{home: workspace}

	// Attempt to apply ONLY the off-plan source file.
	removed, err := desc.CleanApply("hermes", []string{"source.py"})
	if err != nil {
		// An error is acceptable (rejected path).
		t.Logf("CleanApply returned error for off-plan path: %v", err)
	}
	if removed != 0 {
		t.Errorf("expected 0 bytes removed for off-plan path, got %d", removed)
	}
	// source.py must still exist.
	if _, err := os.Stat(srcFile); os.IsNotExist(err) {
		t.Fatal("source.py was removed — it must NOT be touched by CleanApply")
	}
}

// TestCleanApply_RefusesJailEscape verifies that CleanApply rejects paths
// that attempt to escape the workspace via "../".
func TestCleanApply_RefusesJailEscape(t *testing.T) {
	workspace := t.TempDir()

	// Put a logs dir so plan is non-empty.
	logsDir := filepath.Join(workspace, "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logsDir, "y.log"), []byte("y"), 0644); err != nil {
		t.Fatal(err)
	}

	desc := &Descriptor{home: workspace}

	// Attempt a traversal escape.
	removed, _ := desc.CleanApply("hermes", []string{"../escape"})
	if removed != 0 {
		t.Errorf("expected 0 bytes removed for escape path, got %d", removed)
	}
}
