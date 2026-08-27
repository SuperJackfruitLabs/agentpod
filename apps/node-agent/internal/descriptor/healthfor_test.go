package descriptor

import (
	"path/filepath"
	"testing"
)

// workspaceStation builds a Station carrying an already-resolved workspace, as
// a caller would have after DetectAll. The key deliberately does NOT correspond
// to anything the descriptor would discover on this host.
func workspaceStation(key, ws string) Station {
	return Station{Key: key, Harness: "test", Kind: "leaf", WorkspacePath: &ws}
}

// TestWorkspaceDescriptorsImplementHealthForStation pins the optimisation in
// place: these three descriptors resolve a station key by re-running Detect, so
// they are the ones a health sweep must not call by key. If one stops
// implementing HealthForStation, the sweep silently returns to O(N²) host
// scans with nothing failing — hence this assertion.
func TestWorkspaceDescriptorsImplementHealthForStation(t *testing.T) {
	home := t.TempDir()
	for _, tc := range []struct {
		name string
		d    Descriptor
	}{
		{"claude-code", NewClaudeCode(filepath.Join(home, ".claude"))},
		{"codex", NewCodex(filepath.Join(home, ".codex"))},
		{"opencode", NewOpenCode(filepath.Join(home, "opencode"))},
	} {
		if _, ok := tc.d.(HealthForStation); !ok {
			t.Errorf("%s descriptor (%T) must implement HealthForStation: its Health(key) "+
				"re-runs Detect, which makes a health sweep quadratic", tc.name, tc.d)
		}
	}
}

// TestHealthForUsesStationWorkspace proves the fast path really does read the
// workspace off the Station rather than re-resolving the key.
//
// The station key is unknown to the descriptor — Detect on an empty HOME finds
// nothing — so any implementation that went back through projectPathForKey
// would fail with "station not found". Succeeding is the proof.
func TestHealthForUsesStationWorkspace(t *testing.T) {
	home := t.TempDir()
	ws := t.TempDir()

	for _, tc := range []struct {
		name string
		d    Descriptor
	}{
		{"claude-code", NewClaudeCode(filepath.Join(home, ".claude"))},
		{"codex", NewCodex(filepath.Join(home, ".codex"))},
		{"opencode", NewOpenCode(filepath.Join(home, "opencode"))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hf, ok := tc.d.(HealthForStation)
			if !ok {
				t.Skipf("%s does not implement HealthForStation", tc.name)
			}
			if _, err := hf.HealthFor(workspaceStation("test:not-a-real-key", ws)); err != nil {
				t.Fatalf("HealthFor with a resolved workspace: %v; the workspace on the "+
					"Station must be used directly, not re-resolved from the key", err)
			}
		})
	}
}

// TestHealthForFallsBackWhenWorkspaceMissing asserts the documented contract:
// a Station with no workspace falls back to the key-resolving Health, which on
// an empty HOME means a "not found" error rather than a bogus snapshot.
func TestHealthForFallsBackWhenWorkspaceMissing(t *testing.T) {
	home := t.TempDir()
	d := NewClaudeCode(filepath.Join(home, ".claude"))

	hf, ok := d.(HealthForStation)
	if !ok {
		t.Fatal("claude-code must implement HealthForStation")
	}
	if _, err := hf.HealthFor(Station{Key: "claude-code:nope"}); err == nil {
		t.Fatal("HealthFor with a nil WorkspacePath must fall back to Health(key), " +
			"which cannot resolve an unknown key — got no error")
	}
}

// TestHealthOfPrefersFastPath covers the dispatch helper itself.
func TestHealthOfPrefersFastPath(t *testing.T) {
	ws := t.TempDir()
	d := NewClaudeCode(filepath.Join(t.TempDir(), ".claude"))

	// Unknown key + resolved workspace: only the fast path can answer this.
	if _, err := HealthOf(d, workspaceStation("claude-code:unknown", ws)); err != nil {
		t.Fatalf("HealthOf did not take the HealthForStation path: %v", err)
	}
}
