package gitops

import (
	"os/exec"
	"strings"
	"testing"
)

func headSHA(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("rev-parse HEAD: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func TestSelectBaseExplicitWins(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	first := headSHA(t, dir)
	write(t, dir, "a.txt", "two\n")
	gitDo(t, dir, "commit", "-qam", "second")

	got, err := SelectBase(t.Context(), dir, first)
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.Reason != "explicit" {
		t.Errorf("Reason = %q, want explicit", got.Reason)
	}
	if got.SHA != first {
		t.Errorf("SHA = %q, want %q", got.SHA, first)
	}
}

func TestSelectBaseFallsBackToHead(t *testing.T) {
	// No upstream, no origin: the only honest base is HEAD, and the committed
	// side is then empty by construction.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")

	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.Reason != "head" {
		t.Errorf("Reason = %q, want head", got.Reason)
	}
	if got.SHA != headSHA(t, dir) {
		t.Errorf("SHA = %q, want HEAD", got.SHA)
	}
}

func TestSelectBasePrefersTheUpstream(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	base := headSHA(t, dir)

	// A local "remote" is enough: an upstream is just refs plus config. The
	// fetch refspec is required — without it git refuses to resolve @{upstream}
	// with "not stored as a remote-tracking branch", because it has no mapping
	// from refs/heads/main on origin to refs/remotes/origin/main.
	gitDo(t, dir, "update-ref", "refs/remotes/origin/main", base)
	gitDo(t, dir, "config", "remote.origin.url", ".")
	gitDo(t, dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
	gitDo(t, dir, "config", "branch.main.remote", "origin")
	gitDo(t, dir, "config", "branch.main.merge", "refs/heads/main")

	write(t, dir, "a.txt", "two\n")
	gitDo(t, dir, "commit", "-qam", "second")

	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.Reason != "upstream" {
		t.Errorf("Reason = %q, want upstream", got.Reason)
	}
	if got.Ref != "origin/main" {
		t.Errorf("Ref = %q, want origin/main", got.Ref)
	}
	if got.SHA != base {
		t.Errorf("SHA = %q, want the first commit", got.SHA)
	}
}

func TestSelectBaseUsesTheDefaultBranchWhenThereIsNoUpstream(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	base := headSHA(t, dir)

	gitDo(t, dir, "update-ref", "refs/remotes/origin/main", base)
	gitDo(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

	// A branch with NO tracking config.
	gitDo(t, dir, "checkout", "-q", "-b", "feat/x")
	write(t, dir, "b.txt", "new\n")
	gitDo(t, dir, "add", "b.txt")
	gitDo(t, dir, "commit", "-qm", "work")

	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.Reason != "default-branch" {
		t.Errorf("Reason = %q, want default-branch", got.Reason)
	}
	if got.SHA != base {
		t.Errorf("SHA = %q, want the merge base", got.SHA)
	}
}

func TestSelectBaseResolvesToTheMergeBase(t *testing.T) {
	// The base must be the fork point, not the tip. Otherwise commits made on
	// the base after the branch diverged appear as reversed changes on the
	// station's side — work it never did.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	fork := headSHA(t, dir)

	gitDo(t, dir, "checkout", "-q", "-b", "feat/x")
	write(t, dir, "b.txt", "branch work\n")
	gitDo(t, dir, "add", "b.txt")
	gitDo(t, dir, "commit", "-qm", "branch work")

	gitDo(t, dir, "checkout", "-q", "main")
	write(t, dir, "c.txt", "main moved on\n")
	gitDo(t, dir, "add", "c.txt")
	gitDo(t, dir, "commit", "-qm", "main moved on")
	gitDo(t, dir, "update-ref", "refs/remotes/origin/main", headSHA(t, dir))
	gitDo(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

	gitDo(t, dir, "checkout", "-q", "feat/x")

	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.SHA != fork {
		t.Errorf("SHA = %q, want the fork point %q", got.SHA, fork)
	}
}

func TestSelectBaseOnARepoWithNoCommits(t *testing.T) {
	// A freshly-initialised workspace is a normal state for a new station, not
	// an error. Everything in it is untracked, so uncommitted still works.
	dir := gitRepo(t)
	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("an empty repo must not error: %v", err)
	}
	if got.Reason != "head" {
		t.Errorf("Reason = %q, want head", got.Reason)
	}
	if got.SHA != "" {
		t.Errorf("SHA = %q, want empty on an unborn HEAD", got.SHA)
	}
}
