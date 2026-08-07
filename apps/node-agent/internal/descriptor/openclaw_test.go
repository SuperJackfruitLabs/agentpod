package descriptor

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// testdataOpenClawHome returns the absolute path of the fixture .openclaw home.
func testdataOpenClawHome(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("testdata", "openclaw", ".openclaw"))
	if err != nil {
		t.Fatalf("resolve testdata: %v", err)
	}
	return abs
}

// --- Detect ---

func TestOpenClawDetect_ReturnsRootAndSubagents(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClaw(home)

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	// Expect root "openclaw" + two subagent stations.
	if len(stations) != 3 {
		t.Fatalf("expected 3 stations (root + 2 subagents), got %d: %+v", len(stations), stations)
	}

	// Find the root station.
	var root *Station
	subagents := make(map[string]*Station)
	for i := range stations {
		s := &stations[i]
		if s.Key == "openclaw" {
			root = s
		} else {
			subagents[s.Key] = s
		}
	}

	if root == nil {
		t.Fatal("root station 'openclaw' not found")
	}
	if root.Harness != "openclaw" {
		t.Errorf("root harness: want openclaw, got %s", root.Harness)
	}
	if root.Kind != "composite" {
		t.Errorf("root kind: want composite, got %s", root.Kind)
	}
	if root.DisplayName != "OpenClaw" {
		t.Errorf("root displayName: want OpenClaw, got %s", root.DisplayName)
	}
	if root.ParentKey != nil {
		t.Errorf("root parentKey: want nil, got %v", root.ParentKey)
	}
	// Root workspace should be <home>/workspace (the nested workspace dir exists in fixtures).
	wantRootWs := filepath.Join(home, "workspace")
	if root.WorkspacePath == nil || *root.WorkspacePath != wantRootWs {
		t.Errorf("root workspacePath: want %s, got %v", wantRootWs, root.WorkspacePath)
	}

	// Check subagent stations.
	for _, name := range []string{"hanuman", "kubera"} {
		key := "openclaw:" + name
		s, ok := subagents[key]
		if !ok {
			t.Errorf("subagent station %q not found", key)
			continue
		}
		if s.Harness != "openclaw" {
			t.Errorf("%s harness: want openclaw, got %s", key, s.Harness)
		}
		if s.Kind != "composite" {
			t.Errorf("%s kind: want composite, got %s", key, s.Kind)
		}
		if s.ParentKey == nil || *s.ParentKey != "openclaw" {
			t.Errorf("%s parentKey: want openclaw, got %v", key, s.ParentKey)
		}
		// The nested workspace dir exists in fixtures, so workspacePath should use it.
		wantWs := filepath.Join(home, "workspace", "agent-workspaces", name)
		if s.WorkspacePath == nil || *s.WorkspacePath != wantWs {
			t.Errorf("%s workspacePath: want %s, got %v", key, wantWs, s.WorkspacePath)
		}
		if s.DisplayName != name {
			t.Errorf("%s displayName: want %s, got %s", key, name, s.DisplayName)
		}
	}
}

func TestOpenClawDetect_MissingHomeReturnsEmpty(t *testing.T) {
	d := NewOpenClaw("/nonexistent/path/that/does/not/exist")
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect on missing home: %v", err)
	}
	if len(stations) != 0 {
		t.Fatalf("expected empty stations for missing home, got %d", len(stations))
	}
}

// --- ListDir ---

func TestOpenClawListDir_SubagentNestedWorkspace(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClaw(home)

	entries, err := d.ListDir("openclaw:hanuman", "")
	if err != nil {
		t.Fatalf("ListDir hanuman: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least one entry in hanuman nested workspace")
	}
	// Expect workspace.md to be listed.
	var found bool
	for _, e := range entries {
		if e.Name == "workspace.md" {
			found = true
		}
	}
	if !found {
		t.Errorf("workspace.md not found in entries: %+v", entries)
	}
}

func TestOpenClawListDir_DotDotEscapeErrors(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClaw(home)

	_, err := d.ListDir("openclaw:hanuman", "../../../etc")
	if err == nil {
		t.Fatal("expected error for .. escape in ListDir")
	}
}

// --- ReadFile ---

func TestOpenClawReadFile_SubagentFile(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClaw(home)

	content, _, truncated, err := d.ReadFile("openclaw:hanuman", "workspace.md", 0)
	if err != nil {
		t.Fatalf("ReadFile workspace.md: %v", err)
	}
	if truncated {
		t.Error("expected not truncated for small fixture file")
	}
	if !strings.Contains(string(content), "hanuman") {
		t.Errorf("content should contain 'hanuman', got: %s", content)
	}
}

func TestOpenClawReadFile_Truncation(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClaw(home)

	content, _, truncated, err := d.ReadFile("openclaw:hanuman", "workspace.md", 5)
	if err != nil {
		t.Fatalf("ReadFile truncated: %v", err)
	}
	if !truncated {
		t.Error("expected truncated=true when maxBytes < file size")
	}
	if len(content) != 5 {
		t.Errorf("expected 5 bytes, got %d", len(content))
	}
}

func TestOpenClawReadFile_DotDotEscapeErrors(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClaw(home)

	_, _, _, err := d.ReadFile("openclaw:hanuman", "../kubera/workspace.md", 0)
	if err == nil {
		t.Fatal("expected error for .. escape in ReadFile")
	}
}

// --- Health ---

func TestOpenClawHealth_ReturnsHealthStruct(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClaw(home)

	// DiskBytes populates asynchronously (cached background walk); files exist
	// in testdata so it must be non-negative once computed.
	disk := waitForHealthDiskBytes(t, func() (Health, error) { return d.Health("openclaw:hanuman") })
	if disk < 0 {
		t.Errorf("DiskBytes should be >= 0, got %d", disk)
	}
	h, err := d.Health("openclaw:hanuman")
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	// Running is a best-effort bool; just verify no panic/error.
	_ = h.Running
}

func TestOpenClawHealth_UnavailableHasNote(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClaw(home)

	// Health check for a subagent key should always set a Note because
	// per-subagent process state is not separable from the gateway.
	h, err := d.Health("openclaw:hanuman")
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if h.Note == nil || *h.Note == "" {
		t.Error("expected Health.Note to be set for subagent (process not separable)")
	}
}

// --- TailLogs ---

func TestOpenClawTailLogs_EmitsExistingLogFiles(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClaw(home)

	var chunks [][]byte
	ctx := context.Background()
	err := d.TailLogs(ctx, "openclaw", false, func(chunk []byte) error {
		chunks = append(chunks, chunk)
		return nil
	})
	if err != nil {
		t.Fatalf("TailLogs: %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least one chunk from TailLogs")
	}
	var allContent string
	for _, c := range chunks {
		allContent += string(c)
	}
	if !strings.Contains(allContent, "openclaw gateway started") {
		t.Errorf("expected gateway log content, got: %s", allContent)
	}
}
