package posture

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGroupWritableStationDirIsAFinding(t *testing.T) {
	// superchotu 2026-08-11: ~/.openclaw/agents/<name>/ is 775. Anyone in the
	// group can REPLACE that agent's auth.json — which no file-mode check can
	// see, and which is worse than being able to read it.
	defer forceExposure(t, Exposure{Group: true})()

	home := t.TempDir()
	dir := filepath.Join(home, ".openclaw", "agents", "hanuman")
	if err := os.MkdirAll(dir, 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o775); err != nil {
		t.Fatal(err)
	}

	var found bool
	for _, f := range CheckConfigDirs(home) {
		if f.Status == StatusFail && f.Station == "openclaw:hanuman" {
			found = true
		}
	}
	if !found {
		t.Error("a group-writable station config directory must be reported")
	}
}

func TestOwnerOnlyStationDirPasses(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".hermes", "profiles", "analyst-echo")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	for _, f := range CheckConfigDirs(home) {
		if f.Status == StatusFail {
			t.Errorf("a 700 directory must not be a failure: %+v", f)
		}
	}
}

func TestUnreachableWritableDirIsNotAFinding(t *testing.T) {
	// Same reachability rule as files: a 775 directory inside a 700 parent
	// cannot be written by anyone else.
	home := t.TempDir()
	agents := filepath.Join(home, ".openclaw", "agents")
	dir := filepath.Join(agents, "hanuman")
	if err := os.MkdirAll(dir, 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(agents, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(agents, 0o755) })

	for _, f := range CheckConfigDirs(home) {
		if f.Status == StatusFail {
			t.Errorf("an unreachable directory must not be a failure: %+v", f)
		}
	}
}

func TestScanIncludesStationAndDirectoryFindings(t *testing.T) {
	// Scan is what `apn scan` and the verb both call; a check that exists but is
	// not composed in is a check that does not run.
	defer forceExposure(t, Exposure{World: true})()

	home := t.TempDir()
	dir := filepath.Join(home, ".hermes", "profiles", "analyst-echo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	report := Scan(t.Context(), home, KnownHarnesses(), 1)

	var sawStation bool
	for _, f := range report.Findings {
		if f.Station == "hermes:analyst-echo" {
			sawStation = true
		}
	}
	if !sawStation {
		t.Error("Scan does not include per-station findings")
	}
	if report.Grade == "A" {
		t.Error("a world-readable per-profile credential must not grade A")
	}
}
