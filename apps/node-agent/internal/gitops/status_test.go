package gitops

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestGetStatusRejectsANonRepo(t *testing.T) {
	if _, err := GetStatus(t.Context(), t.TempDir(), ""); err == nil {
		t.Fatal("want an error for a directory that is not a repo")
	}
}

func TestGetStatusSeparatesUncommittedFromCommitted(t *testing.T) {
	// The whole point: "the agent is mid-flight" and "finished work is sitting
	// on this machine" are different situations and must not be merged.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	base := headSHA(t, dir)

	// Committed, not on the base.
	write(t, dir, "committed.txt", "done\n")
	gitDo(t, dir, "add", "committed.txt")
	gitDo(t, dir, "commit", "-qm", "agent finished this")

	// Uncommitted, tracked.
	write(t, dir, "a.txt", "one\ntwo\n")
	// Uncommitted, untracked.
	write(t, dir, "scratch.md", "notes\n")

	st, err := GetStatus(t.Context(), dir, base)
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}

	uncommitted := map[string]FileStatus{}
	for _, f := range st.Uncommitted.Files {
		uncommitted[f.Path] = f.Status
	}
	if uncommitted["a.txt"] != StatusModified {
		t.Errorf("a.txt should be uncommitted+modified, got %+v", st.Uncommitted.Files)
	}
	if uncommitted["scratch.md"] != StatusUntracked {
		t.Errorf("scratch.md should be uncommitted+untracked, got %+v", st.Uncommitted.Files)
	}
	if _, leaked := uncommitted["committed.txt"]; leaked {
		t.Error("a committed file leaked into the uncommitted side")
	}

	if len(st.Committed.Files) != 1 || st.Committed.Files[0].Path != "committed.txt" {
		t.Errorf("committed side = %+v, want just committed.txt", st.Committed.Files)
	}
	if len(st.Committed.Commits) != 1 || st.Committed.Commits[0].Subject != "agent finished this" {
		t.Errorf("commits = %+v", st.Committed.Commits)
	}
}

func TestGetStatusCountsLinesOnTrackedChanges(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", "one\ntwo\nthree\n")

	st, err := GetStatus(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if st.Uncommitted.Insertions != 2 {
		t.Errorf("Insertions = %d, want 2", st.Uncommitted.Insertions)
	}
	for _, f := range st.Uncommitted.Files {
		if f.Path == "a.txt" {
			if f.Insertions == nil || *f.Insertions != 2 {
				t.Errorf("a.txt insertions = %v, want 2", f.Insertions)
			}
		}
	}
}

func TestGetStatusLeavesUntrackedFilesUncounted(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "new.txt", "a\nb\nc\n")

	st, _ := GetStatus(t.Context(), dir, "")
	for _, f := range st.Uncommitted.Files {
		if f.Path == "new.txt" && f.Insertions != nil {
			t.Errorf("untracked file was counted (%v) — that needs `git add -N`, which mutates the index", f.Insertions)
		}
	}
}

func TestGetStatusReportsADetachedHead(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	gitDo(t, dir, "checkout", "-q", "--detach")

	st, err := GetStatus(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if !st.Repo.Detached {
		t.Error("Detached should be true")
	}
	if st.Repo.Branch != nil {
		t.Errorf("Branch = %v, want nil", st.Repo.Branch)
	}
}

func TestGetStatusOnACleanRepo(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")

	st, err := GetStatus(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if len(st.Uncommitted.Files) != 0 || len(st.Committed.Files) != 0 {
		t.Errorf("a clean repo should report nothing: %+v", st)
	}
	if st.Committed.Commits == nil {
		t.Error("Commits must be an empty slice, not nil — null would break the contract")
	}
}

func TestGetStatusNeverMutatesTheRepository(t *testing.T) {
	// The invariant. If GIT_OPTIONAL_LOCKS slips, or someone adds `git add -N`
	// to count untracked files, the index is rewritten under a running agent.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", "one\ntwo\n")
	write(t, dir, "untracked.txt", "x\n")

	idx := filepath.Join(dir, ".git", "index")
	before, err := os.ReadFile(idx)
	if err != nil {
		t.Fatalf("read index: %v", err)
	}

	if _, err := GetStatus(t.Context(), dir, ""); err != nil {
		t.Fatalf("GetStatus: %v", err)
	}

	after, err := os.ReadFile(idx)
	if err != nil {
		t.Fatalf("read index: %v", err)
	}
	if string(before) != string(after) {
		t.Error(".git/index changed — this capability must never write to the repository")
	}
}

func TestGetStatusCapsTheFileList(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "seed.txt", "x\n")
	gitDo(t, dir, "add", "seed.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	for i := 0; i < MaxFiles+5; i++ {
		write(t, dir, filepath.Join("many", fmt.Sprintf("f%04d.txt", i)), "x\n")
	}

	st, err := GetStatus(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if len(st.Uncommitted.Files) > MaxFiles {
		t.Errorf("returned %d files, cap is %d", len(st.Uncommitted.Files), MaxFiles)
	}
	if !st.TruncatedFiles {
		t.Error("TruncatedFiles must be set when the cap bites — silently shortening reads as 'that is everything'")
	}
}
