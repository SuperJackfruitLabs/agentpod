package descriptor

import (
	"os/exec"
	"slices"
	"testing"
)

func initRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	dir := t.TempDir()
	cmd := exec.Command("git", "init", "-q")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	return dir
}

func TestAppendChangesetCapOnAGitWorkspace(t *testing.T) {
	dir := initRepo(t)
	got := AppendChangesetCap([]string{"health"}, &dir)
	if !slices.Contains(got, "changeset") {
		t.Errorf("got %v, want changeset advertised for a git workspace", got)
	}
}

func TestAppendChangesetCapOnAPlainDirectory(t *testing.T) {
	// Advertising it here would put a tab on the station that always errors.
	dir := t.TempDir()
	got := AppendChangesetCap([]string{"health"}, &dir)
	if slices.Contains(got, "changeset") {
		t.Errorf("got %v, want no changeset for a non-repo", got)
	}
}

func TestAppendChangesetCapWithNoWorkspace(t *testing.T) {
	got := AppendChangesetCap([]string{"health"}, nil)
	if slices.Contains(got, "changeset") {
		t.Errorf("got %v, want no changeset when there is no workspace", got)
	}
}

func TestAppendChangesetCapKeepsTheOriginalCapabilities(t *testing.T) {
	dir := initRepo(t)
	got := AppendChangesetCap([]string{"health", "logs"}, &dir)
	for _, want := range []string{"health", "logs"} {
		if !slices.Contains(got, want) {
			t.Errorf("%q was dropped: %v", want, got)
		}
	}
}

func TestAppendChangesetCapDoesNotMutateItsInput(t *testing.T) {
	// Descriptors build ONE caps slice and reuse it across several stations, so
	// appending in place would leak one station's capability onto its siblings
	// — including stations whose workspace is not a repo at all.
	dir := initRepo(t)

	base := make([]string, 2, 8) // spare capacity: append would write in place
	base[0], base[1] = "health", "logs"

	_ = AppendChangesetCap(base, &dir)

	if len(base) != 2 {
		t.Errorf("input slice was mutated: %v", base)
	}
	// Also prove the shared backing array was not written through.
	grown := base[:3]
	if grown[2] == "changeset" {
		t.Error("changeset was written into the caller's backing array")
	}
}
