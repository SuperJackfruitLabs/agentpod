//go:build unix

package superbench

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The soak's failure: Hermes, started in the checkpoint member, left
// .hermes/cache/scratch/run_tests.py in the checkout and SuperBench refused
// the checkpoint as dirty. The worker now excludes the harness's scratch in
// the member's own info/exclude, so the checkout reads clean; a project file
// the harness writes beside it is still reported.
func TestRegisteredWorkerHarnessScratchLeavesTheCheckoutClean(t *testing.T) {
	c := registeredTreeFixture(t)
	c.Task.RepositoryName = "b"
	checkout := filepath.Join(c.Task.WorkspaceRoot, "b")
	admin := filepath.Join(c.Task.WorkspaceRoot, ".superbench-git", "b")
	// SuperBench creates admins without Git's template, so info/ is absent.
	if err := os.RemoveAll(filepath.Join(admin, "info")); err != nil {
		t.Fatal(err)
	}
	result := `{"version":"agentpod.superbench-worker.v2","binding":{"board_id":"brd_example1","card_id":"card_example1","run_id":"run_example1","epoch":1},"outcome":"complete","handoff":{"summary":"done"}}`
	c.Task.Arguments = []string{"/bin/sh", "-c", `mkdir -p .hermes/cache/scratch && echo probe > .hermes/cache/scratch/run_tests.py && printf '%s' "$1"`, "fixture", result}
	runRegisteredWorker(t, c)
	if status := registeredGit(t, checkout, "status", "--porcelain", "--untracked-files=all"); status != "" {
		t.Fatalf("harness scratch left the checkout dirty: %q", status)
	}
	if _, err := os.Lstat(filepath.Join(checkout, ".gitignore")); !os.IsNotExist(err) {
		t.Fatal("the repository's .gitignore was written", err)
	}
	// A second run on the reused bench adds nothing.
	c.Task.Arguments = []string{"/bin/sh", "-c", `mkdir -p .hermes/skills && echo skill > .hermes/skills/x.md && printf '%s' "$1"`, "fixture", result}
	runRegisteredWorker(t, c)
	raw, err := os.ReadFile(filepath.Join(admin, "info", "exclude"))
	if err != nil || strings.Count(string(raw), "/.hermes/cache/\n") != 1 {
		t.Fatalf("exclude not written once: %v %q", err, raw)
	}
	if status := registeredGit(t, checkout, "status", "--porcelain", "--untracked-files=all"); status != "?? .hermes/skills/x.md" {
		t.Fatalf("a harness project file is task content and must stay visible: %q", status)
	}
}

func TestAppendExcludeKeepsExistingLines(t *testing.T) {
	admin := t.TempDir()
	if err := os.Mkdir(filepath.Join(admin, "info"), 0700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(admin, "info", "exclude")
	if err := os.WriteFile(p, []byte("# local\n*.log"), 0600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := appendExclude(admin, harnessScratch); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := os.ReadFile(p)
	if string(raw) != "# local\n*.log\n/.hermes/cache/\n" {
		t.Fatalf("exclude: %q", raw)
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(admin, "elsewhere"), p); err != nil {
		t.Fatal(err)
	}
	if appendExclude(admin, harnessScratch) == nil {
		t.Fatal("a symlinked exclude was followed")
	}
}

func runRegisteredWorker(t *testing.T, c RegisteredCapsule) {
	t.Helper()
	raw, err := c.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(t.Context(), exe, "-test.run=^TestRegisteredWorkerSubprocess$")
	cmd.Dir = c.Task.WorkspaceRoot
	cmd.Env = []string{"REGISTERED_WORKER_TEST_CHILD=1", "REGISTERED_WORKER_DIGEST=" + groupedSHA(raw)}
	cmd.Stdin = bytes.NewReader(frameCapsule(raw))
	var out, logs bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &logs
	if err = cmd.Run(); err != nil {
		t.Fatalf("worker: %v %s", err, logs.String())
	}
	if _, err = ParseRegisteredResult(out.Bytes(), c.Task.Binding); err != nil {
		t.Fatal(err)
	}
}
