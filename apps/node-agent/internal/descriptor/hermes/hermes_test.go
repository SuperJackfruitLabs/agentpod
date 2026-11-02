package hermes

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// testdataHermesHome returns the absolute path of the fixture .hermes home.
func testdataHermesHome(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("testdata", "hermes", ".hermes"))
	if err != nil {
		t.Fatalf("resolve testdata: %v", err)
	}
	return abs
}

// --- Detect ---

func TestHermesDetect_ReturnsRootAndProfiles(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	// Expect root "hermes" + two profile stations.
	if len(stations) != 3 {
		t.Fatalf("expected 3 stations (root + 2 profiles), got %d: %+v", len(stations), stations)
	}

	// Find the root station.
	var root *descriptor.Station
	profiles := make(map[string]*descriptor.Station)
	for i := range stations {
		s := &stations[i]
		if s.Key == "hermes" {
			root = s
		} else {
			profiles[s.Key] = s
		}
	}

	if root == nil {
		t.Fatal("root station 'hermes' not found")
	}
	if root.Harness != "hermes" {
		t.Errorf("root harness: want hermes, got %s", root.Harness)
	}
	if root.Kind != "composite" {
		t.Errorf("root kind: want composite, got %s", root.Kind)
	}
	if root.ParentKey != nil {
		t.Errorf("root parentKey: want nil, got %v", root.ParentKey)
	}
	if root.WorkspacePath == nil || *root.WorkspacePath != home {
		t.Errorf("root workspacePath: want %s, got %v", home, root.WorkspacePath)
	}

	// Check profile stations.
	for _, name := range []string{"coder-kai", "research-ray"} {
		key := "hermes:" + name
		s, ok := profiles[key]
		if !ok {
			t.Errorf("profile station %q not found", key)
			continue
		}
		if s.Harness != "hermes" {
			t.Errorf("%s harness: want hermes, got %s", key, s.Harness)
		}
		if s.Kind != "composite" {
			t.Errorf("%s kind: want composite, got %s", key, s.Kind)
		}
		if s.ParentKey == nil || *s.ParentKey != "hermes" {
			t.Errorf("%s parentKey: want hermes, got %v", key, s.ParentKey)
		}
		wantPath := filepath.Join(home, "profiles", name)
		if s.WorkspacePath == nil || *s.WorkspacePath != wantPath {
			t.Errorf("%s workspacePath: want %s, got %v", key, wantPath, s.WorkspacePath)
		}
		if s.DisplayName != name {
			t.Errorf("%s displayName: want %s, got %s", key, name, s.DisplayName)
		}
	}
}

func TestHermesDetect_MissingHomeReturnsEmpty(t *testing.T) {
	d := NewHermes("/nonexistent/path/that/does/not/exist")
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect on missing home: %v", err)
	}
	if len(stations) != 0 {
		t.Fatalf("expected empty stations for missing home, got %d", len(stations))
	}
}

// --- ListDir ---

func TestHermesListDir_RootKey(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	entries, err := d.ListDir("hermes", "")
	if err != nil {
		t.Fatalf("ListDir hermes root: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least one entry in hermes root")
	}
}

func TestHermesListDir_ProfileKey(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	entries, err := d.ListDir("hermes:coder-kai", "")
	if err != nil {
		t.Fatalf("ListDir coder-kai: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least one entry in coder-kai profile dir")
	}
	// Expect session.md to be listed.
	var found bool
	for _, e := range entries {
		if e.Name == "session.md" {
			found = true
		}
	}
	if !found {
		t.Errorf("session.md not found in entries: %+v", entries)
	}
}

func TestHermesListDir_DotDotEscapeErrors(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	_, err := d.ListDir("hermes:coder-kai", "../../../etc")
	if err == nil {
		t.Fatal("expected error for .. escape in ListDir")
	}
}

// --- ReadFile ---

func TestHermesReadFile_ProfileFile(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	content, _, truncated, err := d.ReadFile("hermes:coder-kai", "session.md", 0)
	if err != nil {
		t.Fatalf("ReadFile session.md: %v", err)
	}
	if truncated {
		t.Error("expected not truncated for small fixture file")
	}
	if !strings.Contains(string(content), "coder-kai") {
		t.Errorf("content should contain 'coder-kai', got: %s", content)
	}
}

func TestHermesReadFile_Truncation(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	// Use maxBytes=5 to force truncation.
	content, _, truncated, err := d.ReadFile("hermes:coder-kai", "session.md", 5)
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

func TestHermesReadFile_DotDotEscapeErrors(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	_, _, _, err := d.ReadFile("hermes:coder-kai", "../research-ray/notes.txt", 0)
	if err == nil {
		t.Fatal("expected error for .. escape in ReadFile")
	}
}

// --- Health ---

func TestHermesHealth_ReturnsHealthStruct(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	h, err := d.Health("hermes:coder-kai")
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	// DiskBytes should be non-nil and non-negative (files exist in testdata).
	if h.DiskBytes == nil {
		t.Error("expected DiskBytes to be set")
	} else if *h.DiskBytes < 0 {
		t.Errorf("DiskBytes should be >= 0, got %d", *h.DiskBytes)
	}
	// Running is a best-effort bool; just verify no panic/error.
	_ = h.Running
}

// --- TailLogs ---

func TestHermesTailLogs_EmitsExistingContent(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	var chunks [][]byte
	ctx := context.Background()
	err := d.TailLogs(ctx, "hermes", false, func(chunk []byte) error {
		chunks = append(chunks, chunk)
		return nil
	})
	if err != nil {
		t.Fatalf("TailLogs: %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least one chunk from TailLogs")
	}
	// Verify log content is present.
	var allContent string
	for _, c := range chunks {
		allContent += string(c)
	}
	if !strings.Contains(allContent, "hermes gateway started") {
		t.Errorf("expected log content, got: %s", allContent)
	}
}
