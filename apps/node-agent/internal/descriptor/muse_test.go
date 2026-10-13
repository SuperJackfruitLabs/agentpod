package descriptor

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// museTestDescriptor builds a descriptor with every host seam stubbed, so no
// test needs muse, muse-acp or sqlite3 installed and none touches PATH.
func museTestDescriptor(t *testing.T, home string, sessions func(string) ([]string, error)) *museDescriptor {
	t.Helper()
	d := NewMuseFrom(MuseConfig{Home: home}).(*museDescriptor)
	d.userHome = home
	d.lookPath = func(string) (string, error) { return "", errors.New("not on PATH") }
	d.isExecutable = func(string) bool { return false }
	d.getenv = func(string) string { return "" }
	d.processRunning = func(string) (bool, string) { return false, "" }
	d.workspaceRoots = sessions
	return d
}

func TestMuseHarnessName(t *testing.T) {
	d := museTestDescriptor(t, t.TempDir(), func(string) ([]string, error) { return nil, nil })
	if got := d.Harness(); got != "muse" {
		t.Fatalf("Harness() = %q, want %q", got, "muse")
	}
}

// A host where Muse has never run is not an error — it simply has no stations.
func TestMuseDetectNoHome(t *testing.T) {
	d := museTestDescriptor(t, filepath.Join(t.TempDir(), "absent"), func(string) ([]string, error) {
		t.Fatal("workspaceRoots must not be consulted when the home is absent")
		return nil, nil
	})
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect() error = %v, want nil", err)
	}
	if len(stations) != 0 {
		t.Fatalf("Detect() = %d stations, want 0", len(stations))
	}
	if stations == nil {
		t.Fatal("Detect() returned a nil slice; callers append to it")
	}
}

// The session index is the authority: one station per distinct workspace root.
func TestMuseDetectFromSessionIndex(t *testing.T) {
	home := t.TempDir()
	mustMuseHome(t, home)
	wsA := t.TempDir()
	wsB := t.TempDir()

	d := museTestDescriptor(t, home, func(string) ([]string, error) {
		// Duplicates are what the index actually contains: one row per session,
		// many sessions per workspace.
		return []string{wsA, wsB, wsA}, nil
	})

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if len(stations) != 2 {
		t.Fatalf("Detect() = %d stations, want 2 (deduplicated)", len(stations))
	}
	for _, s := range stations {
		if s.Harness != "muse" {
			t.Errorf("station %q harness = %q, want muse", s.Key, s.Harness)
		}
		if s.Kind != "leaf" {
			t.Errorf("station %q kind = %q, want leaf", s.Key, s.Kind)
		}
		if s.WorkspacePath == nil {
			t.Fatalf("station %q has no workspace path", s.Key)
		}
		if s.DisplayName != filepath.Base(*s.WorkspacePath) {
			t.Errorf("station %q display name = %q, want %q", s.Key, s.DisplayName, filepath.Base(*s.WorkspacePath))
		}
	}
	if stations[0].Key == stations[1].Key {
		t.Fatalf("both stations share key %q; keys must be per-workspace", stations[0].Key)
	}
}

// A workspace that has been deleted is not a station. Only "it is gone" drops
// one — the same rule codex and claude-code follow.
func TestMuseDetectDropsMissingWorkspaces(t *testing.T) {
	home := t.TempDir()
	mustMuseHome(t, home)
	ws := t.TempDir()
	gone := filepath.Join(t.TempDir(), "deleted-workspace")

	d := museTestDescriptor(t, home, func(string) ([]string, error) {
		return []string{ws, gone, "relative/path"}, nil
	})

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if len(stations) != 1 {
		t.Fatalf("Detect() = %d stations, want 1 (missing and relative paths dropped)", len(stations))
	}
	if *stations[0].WorkspacePath != ws {
		t.Fatalf("surviving station workspace = %q, want %q", *stations[0].WorkspacePath, ws)
	}
}

// An unreadable index is reported, not silently swallowed: a host with Muse
// installed and no sqlite3 should say why its stations are missing.
func TestMuseDetectReportsUnreadableIndex(t *testing.T) {
	home := t.TempDir()
	mustMuseHome(t, home)
	d := museTestDescriptor(t, home, func(string) ([]string, error) {
		return nil, errors.New("sqlite3 query failed: executable file not found in $PATH")
	})
	if _, err := d.Detect(); err == nil {
		t.Fatal("Detect() error = nil, want the index read failure surfaced")
	}
}

// The parity set every leaf harness advertises, minus acp (gated below).
func TestMuseDetectCapabilityParity(t *testing.T) {
	home := t.TempDir()
	mustMuseHome(t, home)
	ws := t.TempDir()
	d := museTestDescriptor(t, home, func(string) ([]string, error) { return []string{ws}, nil })

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	for _, want := range []string{"skills.inventory", "health", "logs", "fs.read", "fs.write", "terminal", "cleanup"} {
		if !hasCap(stations[0].Capabilities, want) {
			t.Errorf("capabilities %v missing %q", stations[0].Capabilities, want)
		}
	}
}

// Both halves of the chat path, or neither: the 2026-08-12 Pi lesson, where
// checking only the adapter gave every station a Chat tab that died in 500ms.
func TestMuseACPGateNeedsBothHalves(t *testing.T) {
	home := t.TempDir()
	mustMuseHome(t, home)
	ws := t.TempDir()

	cases := []struct {
		name    string
		adapter bool
		muse    bool
		wantACP bool
	}{
		{"neither resolves", false, false, false},
		{"adapter only", true, false, false},
		{"muse only", false, true, false},
		{"both resolve", true, true, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := museTestDescriptor(t, home, func(string) ([]string, error) { return []string{ws}, nil })
			d.lookPath = func(name string) (string, error) {
				if name == museACPBinaryName && tc.adapter {
					return "/usr/local/bin/" + museACPBinaryName, nil
				}
				if name == museBinaryName && tc.muse {
					return "/usr/local/bin/" + museBinaryName, nil
				}
				return "", errors.New("not found")
			}

			stations, err := d.Detect()
			if err != nil {
				t.Fatalf("Detect() error = %v", err)
			}
			if got := hasCap(stations[0].Capabilities, "acp"); got != tc.wantACP {
				t.Fatalf("acp advertised = %v, want %v (caps %v)", got, tc.wantACP, stations[0].Capabilities)
			}
		})
	}
}

// ACPCommand spawns the adapter in the station's workspace, and names the muse
// binary it must drive — the adapter reads MUSE_CLI.
func TestMuseACPCommand(t *testing.T) {
	home := t.TempDir()
	mustMuseHome(t, home)
	ws := t.TempDir()
	d := museTestDescriptor(t, home, func(string) ([]string, error) { return []string{ws}, nil })
	d.lookPath = func(name string) (string, error) { return "/opt/bin/" + name, nil }

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}

	argv, dir, env, err := d.ACPCommand(stations[0].Key)
	if err != nil {
		t.Fatalf("ACPCommand() error = %v", err)
	}
	if len(argv) == 0 || filepath.Base(argv[0]) != museACPBinaryName {
		t.Fatalf("argv = %v, want the adapter first", argv)
	}
	if dir != ws {
		t.Fatalf("dir = %q, want the station workspace %q", dir, ws)
	}
	if !hasEnv(env, "MUSE_CLI=/opt/bin/"+museBinaryName) {
		t.Fatalf("env = %v, want MUSE_CLI naming the resolved muse binary", env)
	}
}

func TestMuseACPCommandUnknownKey(t *testing.T) {
	home := t.TempDir()
	mustMuseHome(t, home)
	d := museTestDescriptor(t, home, func(string) ([]string, error) { return nil, nil })
	if _, _, _, err := d.ACPCommand("muse:deadbeef"); err == nil {
		t.Fatal("ACPCommand() on an unknown key = nil error, want a refusal")
	}
}

// mustMuseHome creates the home directory Detect stats before reading the index.
func mustMuseHome(t *testing.T, home string) {
	t.Helper()
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("creating muse home: %v", err)
	}
}

func hasCap(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}

func hasEnv(env []string, want string) bool {
	for _, e := range env {
		if e == want {
			return true
		}
	}
	return false
}
