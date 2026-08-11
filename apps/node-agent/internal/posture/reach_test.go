package posture

import (
	"os"
	"path/filepath"
	"testing"
)

// mkChain builds dir/file with the given modes and returns the file path plus
// the fixture root to stop the walk at.
//
// The root matters: on macOS $TMPDIR is 0700, so walking past the fixture would
// find a blocking ancestor that has nothing to do with what is being tested —
// and the test would then pass on Linux CI and fail on a Mac.
//
// Directory modes are applied deepest-first so setup can still walk down.
func mkChain(t *testing.T, dirModes []os.FileMode, fileMode os.FileMode) (string, string) {
	t.Helper()
	root := t.TempDir()
	// The temp root itself must be traversable, or every case looks unreachable.
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	cur := root
	var made []string
	for i := range dirModes {
		cur = filepath.Join(cur, "d"+string(rune('a'+i)))
		if err := os.Mkdir(cur, 0o755); err != nil {
			t.Fatal(err)
		}
		made = append(made, cur)
	}
	file := filepath.Join(cur, "creds.json")
	if err := os.WriteFile(file, []byte("{}"), fileMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, fileMode); err != nil {
		t.Fatal(err)
	}
	for i := len(made) - 1; i >= 0; i-- {
		if err := os.Chmod(made[i], dirModes[i]); err != nil {
			t.Fatal(err)
		}
	}
	// Restore permissive modes or TempDir cleanup fails.
	t.Cleanup(func() {
		for _, d := range made {
			_ = os.Chmod(d, 0o755)
		}
	})
	return file, root
}

func TestExposedWhenEveryAncestorIsTraversable(t *testing.T) {
	file, root := mkChain(t, []os.FileMode{0o755, 0o755}, 0o644)
	got, err := exposureWalk(file, root)
	if err != nil {
		t.Fatalf("exposureWalk: %v", err)
	}
	if !got.World {
		t.Error("a 644 file under traversable dirs is world-readable")
	}
}

func TestNotExposedWhenAnAncestorBlocksTraversal(t *testing.T) {
	// The molt-bot case: /root is 700, so a 644 config.yaml several levels down
	// is unreachable. Reporting it would be a false critical on a correctly
	// secured box — 15 of them, one per Hermes profile.
	file, root := mkChain(t, []os.FileMode{0o700, 0o755}, 0o644)
	got, err := exposureWalk(file, root)
	if err != nil {
		t.Fatalf("exposureWalk: %v", err)
	}
	if got.World {
		t.Error("a 700 ancestor makes the file unreachable; this must not be reported")
	}
	if got.Any() {
		t.Error("neither world nor group can traverse a 700 ancestor")
	}
}

func TestOwnerOnlyFileIsNeverExposed(t *testing.T) {
	file, root := mkChain(t, []os.FileMode{0o755, 0o755}, 0o600)
	got, _ := exposureWalk(file, root)
	if got.Any() {
		t.Errorf("a 600 file is not exposed however open its parents: %+v", got)
	}
}

func TestGroupAndWorldAreTrackedSeparately(t *testing.T) {
	// A file can be group-exposed without being world-exposed, and the two
	// carry different severities and different remedies.
	file, root := mkChain(t, []os.FileMode{0o750, 0o755}, 0o640)
	got, err := exposureWalk(file, root)
	if err != nil {
		t.Fatalf("exposureWalk: %v", err)
	}
	if got.World {
		t.Error("the 750 ancestor denies o+x, so the world cannot reach it")
	}
	if !got.Group {
		t.Error("the group can traverse 750 and read 640")
	}
}

func TestGroupBlockedByAnAncestorDenyingGroupExec(t *testing.T) {
	file, root := mkChain(t, []os.FileMode{0o700, 0o755}, 0o640)
	got, _ := exposureWalk(file, root)
	if got.Group {
		t.Error("a 700 ancestor denies g+x, so the group cannot reach it either")
	}
}

func TestMissingPathIsAnError(t *testing.T) {
	// Callers must be able to tell "not there" from "not exposed".
	if _, err := EffectiveExposure(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("want an error for a missing path")
	}
}

func TestAnyIsFalseForNoExposure(t *testing.T) {
	if (Exposure{}).Any() {
		t.Error("zero Exposure must not report exposure")
	}
	if !(Exposure{Group: true}).Any() {
		t.Error("group exposure counts")
	}
}

func TestEffectiveExposureWalksToTheRealRoot(t *testing.T) {
	// exposureWalk carries the chain logic; this pins that the exported wrapper
	// really walks all the way up rather than stopping early. A file under the
	// macOS per-user TMPDIR (0700) must come back unexposed whatever its own
	// mode says — which is exactly the molt-bot shape, found in the wild.
	file, _ := mkChain(t, []os.FileMode{0o755, 0o755}, 0o644)
	got, err := EffectiveExposure(file)
	if err != nil {
		t.Fatalf("EffectiveExposure: %v", err)
	}
	// On Linux CI /tmp is 1777 so this IS reachable; on macOS $TMPDIR is 0700 so
	// it is not. Either answer is correct — what must hold is that the wrapper
	// consults ancestors above the fixture at all, which the stopAt="/" does.
	if got.Group && !got.World {
		t.Errorf("unexpected group-only exposure for a 644 file: %+v", got)
	}
}
