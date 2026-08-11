package gitops

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

// gitRepo builds a throwaway repository and returns its path. Tests that need
// real git skip cleanly where it is absent — CI has it, a minimal container
// might not.
func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
		{"config", "commit.gpgsign", "false"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

func gitDo(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGitEnvDisablesOptionalLocks(t *testing.T) {
	// Without this, `git status` takes the index lock to refresh it — on
	// workspaces where an agent is actively editing. The contention it causes
	// is rare and its cause is a long way from its symptom.
	if !slices.Contains(gitEnv(), "GIT_OPTIONAL_LOCKS=0") {
		t.Errorf("GIT_OPTIONAL_LOCKS=0 missing from %v", gitEnv())
	}
}

func TestGitEnvIsNonInteractive(t *testing.T) {
	// A git that can prompt is a git that can hang a gateway handler forever.
	env := gitEnv()
	if !slices.Contains(env, "GIT_TERMINAL_PROMPT=0") {
		t.Errorf("GIT_TERMINAL_PROMPT=0 missing from %v", env)
	}
}

func TestRunReturnsOutput(t *testing.T) {
	dir := gitRepo(t)
	out, err := run(t.Context(), dir, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if string(out) != "true\n" {
		t.Errorf("out = %q", out)
	}
}

func TestRunSurfacesGitStderr(t *testing.T) {
	dir := gitRepo(t)
	_, err := run(t.Context(), dir, "rev-parse", "--verify", "definitely-not-a-ref")
	if err == nil {
		t.Fatal("want an error for an unknown ref")
	}
}

func TestRunHonoursACancelledContext(t *testing.T) {
	dir := gitRepo(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := run(ctx, dir, "status"); err == nil {
		t.Fatal("want an error on a cancelled context")
	}
}

func TestRunAllowExit1TreatsOneAsSuccess(t *testing.T) {
	// `git diff --no-index` exits 1 when the files differ, which is the normal
	// case for showing an untracked file's content, not a failure.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "hello\n")
	out, err := runAllowExit1(t.Context(), dir, "diff", "--no-index", "--", os.DevNull, "a.txt")
	if err != nil {
		t.Fatalf("runAllowExit1: %v", err)
	}
	if len(out) == 0 {
		t.Error("want a patch for a new file")
	}
}

func TestIsRepo(t *testing.T) {
	dir := gitRepo(t)
	if !IsRepo(t.Context(), dir) {
		t.Error("a git repo should be recognised")
	}
	if IsRepo(t.Context(), t.TempDir()) {
		t.Error("a plain directory is not a repo")
	}
}

func TestIsRepoOnAMissingDirectory(t *testing.T) {
	if IsRepo(t.Context(), filepath.Join(t.TempDir(), "nope")) {
		t.Error("a missing directory is not a repo")
	}
}
