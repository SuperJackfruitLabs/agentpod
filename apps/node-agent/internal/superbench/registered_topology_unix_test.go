//go:build unix

package superbench

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func registeredGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), "/usr/bin/git", args...)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0"}
	raw, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Git fixture %v: %v %s", args, err, raw)
	}
	return strings.TrimSpace(string(raw))
}
func registeredStat(t *testing.T, p string) RegisteredNode {
	t.Helper()
	s, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	n, ok := s.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("missing physical identity")
	}
	return RegisteredNode{Device: fmt.Sprint(n.Dev), Inode: strconv.FormatUint(n.Ino, 10)}
}
func registeredTreeFixture(t *testing.T) RegisteredCapsule {
	t.Helper()
	c := registeredCodecFixture(t)
	if err := os.MkdirAll(c.Task.WorkspaceRoot, 0700); err != nil {
		t.Fatal(err)
	}
	root := c.Task.WorkspaceRoot
	mkdir := func(p string) {
		t.Helper()
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	c.Task.Members = nil
	c.Layout.Members = nil
	for _, name := range []string{"a", "b"} {
		checkout := filepath.Join(root, name)
		admin := filepath.Join(root, ".superbench-git", name)
		mkdir(filepath.Dir(admin))
		mkdir(checkout)
		registeredGit(t, root, "init", "--initial-branch=card/card_example1", "--separate-git-dir="+admin, checkout)
		mkdir(admin)
		if err := os.WriteFile(filepath.Join(checkout, "file"), []byte("source\n"), 0600); err != nil {
			t.Fatal(err)
		}
		registeredGit(t, checkout, "add", "file")
		commit := registeredGit(t, checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "source")
		_ = commit
		head := registeredGit(t, checkout, "rev-parse", "HEAD")
		origin := "https://example.invalid/" + name + ".git"
		registeredGit(t, checkout, "config", "remote.origin.url", origin)
		home, tmp := filepath.Join(root, ".superbench-runtime", name, "home"), filepath.Join(root, ".superbench-runtime", name, "tmp")
		mkdir(home)
		mkdir(tmp)
		c.Task.Members = append(c.Task.Members, GroupedMember{Name: name, RepositorySHA256: groupedSHA([]byte(origin)), TaskRef: "refs/heads/card/card_example1", ObjectFormat: "sha1", Commit: head})
		c.Layout.Members = append(c.Layout.Members, RegisteredMember{Name: name, Checkout: registeredStat(t, checkout), Admin: registeredStat(t, admin), Home: registeredStat(t, home), Temp: registeredStat(t, tmp)})
	}
	home, tmp := filepath.Join(root, ".superbench-runtime", ".root", "home"), filepath.Join(root, ".superbench-runtime", ".root", "tmp")
	mkdir(home)
	mkdir(tmp)
	c.Layout.Root = registeredStat(t, root)
	c.Layout.RootHome = registeredStat(t, home)
	c.Layout.RootTemp = registeredStat(t, tmp)
	if err := inspectRegistered(context.Background(), c); err != nil {
		t.Fatal("positive independent-admin fixture refused", err)
	}
	return c
}
func TestRegisteredIndependentAdminsRejectForeignOrChangedTopology(t *testing.T) {
	for name, change := range map[string]func(*testing.T, *RegisteredCapsule){
		"inode": func(t *testing.T, c *RegisteredCapsule) { c.Layout.Members[1].Admin.Inode = "1" },
		"symlink-admin": func(t *testing.T, c *RegisteredCapsule) {
			p := filepath.Join(c.Task.WorkspaceRoot, ".superbench-git", "b")
			if err := os.Rename(p, p+"-old"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(p+"-old", p); err != nil {
				t.Fatal(err)
			}
		},
		"foreign-common": func(t *testing.T, c *RegisteredCapsule) {
			if err := os.WriteFile(filepath.Join(c.Task.WorkspaceRoot, ".superbench-git", "b", "commondir"), []byte("/foreign\n"), 0600); err != nil {
				t.Fatal(err)
			}
		},
		"alternates": func(t *testing.T, c *RegisteredCapsule) {
			if err := os.WriteFile(filepath.Join(c.Task.WorkspaceRoot, ".superbench-git", "b", "objects", "info", "alternates"), []byte("/foreign\n"), 0600); err != nil {
				t.Fatal(err)
			}
		},
		"advanced-head": func(t *testing.T, c *RegisteredCapsule) {
			registeredGit(t, filepath.Join(c.Task.WorkspaceRoot, "b"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "advanced")
		},
		"wrong-origin": func(t *testing.T, c *RegisteredCapsule) {
			registeredGit(t, filepath.Join(c.Task.WorkspaceRoot, "b"), "config", "remote.origin.url", "https://example.invalid/foreign")
		},
		"dirty-index": func(t *testing.T, c *RegisteredCapsule) {
			p := filepath.Join(c.Task.WorkspaceRoot, "b")
			if err := os.WriteFile(filepath.Join(p, "file"), []byte("changed\n"), 0600); err != nil {
				t.Fatal(err)
			}
			registeredGit(t, p, "add", "file")
		},
		"hidden-index": func(t *testing.T, c *RegisteredCapsule) {
			registeredGit(t, filepath.Join(c.Task.WorkspaceRoot, "b"), "update-index", "--assume-unchanged", "file")
		},
	} {
		t.Run(name, func(t *testing.T) {
			c := registeredTreeFixture(t)
			change(t, &c)
			if err := inspectRegistered(context.Background(), c); !errors.Is(err, ErrRegisteredLayout) {
				t.Fatal("wrong refusal", err)
			}
		})
	}
}
func TestRegisteredWorkerSubprocess(t *testing.T) {
	if os.Getenv("REGISTERED_WORKER_TEST_CHILD") != "1" {
		return
	}
	err := ExecuteRegisteredWorker(context.Background(), os.Stdin, os.Stdout, os.Stderr, os.Getenv("REGISTERED_WORKER_DIGEST"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}
func TestRegisteredWorkerConsumesFrameAndSeparatesLogsFromResult(t *testing.T) {
	c := registeredTreeFixture(t)
	result := `{"version":"agentpod.superbench-worker.v2","binding":{"board_id":"brd_example1","card_id":"card_example1","run_id":"run_example1","epoch":1},"outcome":"complete","handoff":{"summary":"done"}}`
	c.Task.Arguments = []string{"/bin/sh", "-c", `printf '%s' "$1"; printf 'harness-log\n' >&2`, "fixture", result}
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
	cmd.Stdout = &out
	cmd.Stderr = &logs
	if err = cmd.Run(); err != nil {
		t.Fatalf("worker: %v %s", err, logs.String())
	}
	got, err := ParseRegisteredResult(out.Bytes(), c.Task.Binding)
	if err != nil || got.Handoff["summary"] != "done" || logs.String() != "harness-log\n" {
		t.Fatalf("result/log channels mixed: %v %q %q", err, out.Bytes(), logs.String())
	}
	// No Node-private directory or files are used or created by this mode.
	for _, name := range []string{"started", "request.json", "result.json", "home", "tmp"} {
		if _, err := os.Lstat(filepath.Join(c.Task.WorkspaceRoot, name)); !os.IsNotExist(err) {
			t.Fatal("unexpected context write", name, err)
		}
	}
}

func TestRegisteredWorkerLateMemberRefusalHasNoHarnessEffects(t *testing.T) {
	c := registeredTreeFixture(t)
	marker := filepath.Join(t.TempDir(), "harness-ran")
	c.Task.Arguments = []string{"/bin/sh", "-c", `touch "$1"`, "fixture", marker}
	// A genuine valid full-vector observation preceded this one late source change.
	registeredGit(t, filepath.Join(c.Task.WorkspaceRoot, "b"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "late")
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
	cmd.Stdout = &out
	cmd.Stderr = &logs
	err = cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || out.Len() != 0 || logs.String() != ErrRegisteredLayout.Error()+"\n" {
		t.Fatalf("wrong refusal: %v %q %q", err, out.Bytes(), logs.String())
	}
	if _, err = os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatal("refused vector launched harness", err)
	}
}
