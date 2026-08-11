package gitops

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestGetDiffOfATrackedChange(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", "one\ntwo\n")

	got, err := GetDiff(t.Context(), dir, "uncommitted", "a.txt", "", 0)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if !strings.Contains(got.Content, "+two") {
		t.Errorf("patch missing the added line:\n%s", got.Content)
	}
}

func TestGetDiffShowsAnUntrackedFile(t *testing.T) {
	// The reason this matters: agents create files constantly, `git diff` shows
	// none of them, and we refuse to use `git add -N` to make them visible.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "brand-new.txt", "hello from the agent\n")

	got, err := GetDiff(t.Context(), dir, "uncommitted", "brand-new.txt", "", 0)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if !strings.Contains(got.Content, "hello from the agent") {
		t.Errorf("untracked file content missing:\n%s", got.Content)
	}
}

func TestGetDiffWholeUncommittedSideIncludesUntrackedFiles(t *testing.T) {
	// "Show me everything" must not quietly mean "everything git tracks".
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", "one\nmodified\n")
	write(t, dir, "brand-new.txt", "untracked content\n")

	got, err := GetDiff(t.Context(), dir, "uncommitted", "", "", 0)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if !strings.Contains(got.Content, "+modified") {
		t.Errorf("tracked change missing:\n%s", got.Content)
	}
	if !strings.Contains(got.Content, "untracked content") {
		t.Errorf("untracked file missing from the whole-side patch:\n%s", got.Content)
	}
}

func TestGetDiffOfTheCommittedSide(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	base := headSHA(t, dir)
	write(t, dir, "b.txt", "committed work\n")
	gitDo(t, dir, "add", "b.txt")
	gitDo(t, dir, "commit", "-qm", "second")

	got, err := GetDiff(t.Context(), dir, "committed", "", base, 0)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if !strings.Contains(got.Content, "committed work") {
		t.Errorf("committed change missing:\n%s", got.Content)
	}
}

func TestGetDiffTruncatesAndSaysSo(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "seed\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", strings.Repeat("a long line of content\n", 5000))

	got, err := GetDiff(t.Context(), dir, "uncommitted", "a.txt", "", 512)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if len(got.Content) > 512 {
		t.Errorf("content is %d bytes, cap was 512", len(got.Content))
	}
	if !got.Truncated {
		t.Error("Truncated must be set when the cap bites")
	}
}

func TestGetDiffTruncationLandsOnValidUTF8(t *testing.T) {
	// Cutting mid-rune produces replacement characters in the console.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "seed\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", strings.Repeat("héllo wörld ünicode\n", 500))

	// Sweep a range of cut points so at least some land mid-rune.
	for _, n := range []int{300, 301, 302, 303, 511, 512, 513} {
		got, err := GetDiff(t.Context(), dir, "uncommitted", "a.txt", "", n)
		if err != nil {
			t.Fatalf("GetDiff(%d): %v", n, err)
		}
		if !utf8.ValidString(got.Content) {
			t.Errorf("truncated content at %d bytes is not valid UTF-8", n)
		}
	}
}

func TestGetDiffRejectsAnUnknownSide(t *testing.T) {
	dir := gitRepo(t)
	if _, err := GetDiff(t.Context(), dir, "sideways", "", "", 0); err == nil {
		t.Fatal("want an error for an unknown side")
	}
}

func TestGetDiffRejectsANonRepo(t *testing.T) {
	if _, err := GetDiff(t.Context(), t.TempDir(), "uncommitted", "", "", 0); err == nil {
		t.Fatal("want an error for a directory that is not a repo")
	}
}

func TestGetDiffRefusesToEscapeTheWorkspace(t *testing.T) {
	// path comes from a hub request. A traversal must not read the host's files.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")

	for _, bad := range []string{"../../../etc/passwd", "/etc/passwd"} {
		if _, err := GetDiff(t.Context(), dir, "uncommitted", bad, "", 0); err == nil {
			t.Errorf("path %q was accepted; it must be rejected", bad)
		}
	}
}
