package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func TestGroupedWorkerCLIChild(t *testing.T) {
	if os.Getenv("GROUPED_WORKER_TEST_CHILD") != "1" {
		return
	}
	for i, a := range os.Args {
		if a == "--" {
			os.Exit(entry(os.Args[i+1:], os.Stdout, os.Stderr))
		}
	}
	os.Exit(99)
}
func TestGroupedCLIExecutesPinnedContextInsideBoundRoot(t *testing.T) {
	testGroupedCLI(t, "valid", nil, false)
}

func TestGroupedCLIRefusesChangedSourceBeforeHarness(t *testing.T) {
	cases := map[string]func(*testing.T, string, string, string, map[string]any){
		"wrong-cwd": func(t *testing.T, base, root, parent string, s map[string]any) {},
		"changed-context": func(t *testing.T, base, root, parent string, s map[string]any) {
			s["prompt"] = "changed by setup"
			raw, _ := json.Marshal(s)
			if e := os.WriteFile(filepath.Join(parent, "request.json"), raw, 0600); e != nil {
				t.Fatal(e)
			}
		},
		"advanced-later-head": func(t *testing.T, base, root, parent string, s map[string]any) {
			runGit(t, filepath.Join(root, "b"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "setup advanced HEAD")
		},
		"wrong-origin": func(t *testing.T, base, root, parent string, s map[string]any) {
			runGit(t, filepath.Join(root, "b"), "config", "remote.origin.url", filepath.Join(base, "other"))
		},
		"wrong-ref": func(t *testing.T, base, root, parent string, s map[string]any) {
			runGit(t, filepath.Join(root, "b"), "checkout", "-b", "unexpected")
		},
		"dirty-later-member": func(t *testing.T, base, root, parent string, s map[string]any) {
			if e := os.WriteFile(filepath.Join(root, "b", "file"), []byte("dirty"), 0600); e != nil {
				t.Fatal(e)
			}
		},
		"hidden-index-dirt": func(t *testing.T, base, root, parent string, s map[string]any) {
			runGit(t, filepath.Join(root, "b"), "update-index", "--assume-unchanged", "file")
			if e := os.WriteFile(filepath.Join(root, "b", "file"), []byte("hidden"), 0600); e != nil {
				t.Fatal(e)
			}
		},
		"untracked": func(t *testing.T, base, root, parent string, s map[string]any) {
			if e := os.WriteFile(filepath.Join(root, "b", "unknown"), []byte("untracked"), 0600); e != nil {
				t.Fatal(e)
			}
		},
		"filter-config": func(t *testing.T, base, root, parent string, s map[string]any) {
			runGit(t, filepath.Join(root, "b"), "config", "filter.test.clean", "touch "+filepath.Join(base, "filter-ran"))
		},
		"alternates": func(t *testing.T, base, root, parent string, s map[string]any) {
			common := strings.TrimSpace(runGit(t, filepath.Join(root, "b"), "rev-parse", "--path-format=absolute", "--git-common-dir"))
			if e := os.WriteFile(filepath.Join(common, "objects", "info", "alternates"), []byte(filepath.Join(base, "outside-objects")+"\n"), 0600); e != nil {
				t.Fatal(e)
			}
		},
		"replacement": func(t *testing.T, base, root, parent string, s map[string]any) {
			commit := membersOf(s)[1]["commit"]
			runGit(t, filepath.Join(root, "b"), "update-ref", "refs/replace/"+commit, commit)
		},
		"omitted-member": func(t *testing.T, base, root, parent string, s map[string]any) {
			if e := os.Rename(filepath.Join(root, "b"), filepath.Join(base, "missing-b")); e != nil {
				t.Fatal(e)
			}
		},
		"staged": func(t *testing.T, base, root, parent string, s map[string]any) {
			if e := os.WriteFile(filepath.Join(root, "b", "file"), []byte("staged"), 0600); e != nil {
				t.Fatal(e)
			}
			runGit(t, filepath.Join(root, "b"), "add", "file")
		},
		"member-symlink": func(t *testing.T, base, root, parent string, s map[string]any) {
			if e := os.Rename(filepath.Join(root, "b"), filepath.Join(base, "preserved-b")); e != nil {
				t.Fatal(e)
			}
			if e := os.Symlink(filepath.Join(base, "preserved-b"), filepath.Join(root, "b")); e != nil {
				t.Fatal(e)
			}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) { testGroupedCLI(t, name, mutate, true) })
	}
}

func testGroupedCLI(t *testing.T, name string, mutate func(*testing.T, string, string, string, map[string]any), refused bool) {
	base, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	root := filepath.Join(base, "data", "benches", "fixture")
	if e = os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	binding := superbench.Binding{BoardID: "brd_example1", CardID: "card_example1", RunID: "run_example1", Epoch: 1}
	members := make([]map[string]string, 0, 2)
	for _, name := range []string{"a", "b"} {
		origin := filepath.Join(base, "origin-"+name)
		runGit(t, "", "init", "-b", "main", origin)
		if e = os.WriteFile(filepath.Join(origin, "file"), []byte("source\n"), 0600); e != nil {
			t.Fatal(e)
		}
		runGit(t, origin, "add", "file")
		runGit(t, origin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source")
		hash := sha256.Sum256([]byte(origin))
		repoHash := hex.EncodeToString(hash[:])
		mirror := filepath.Join(base, "data", "mirrors", repoHash+".git")
		runGit(t, "", "clone", "--mirror", origin, mirror)
		task := "refs/heads/card/" + binding.CardID
		runGit(t, mirror, "worktree", "add", "-b", strings.TrimPrefix(task, "refs/heads/"), filepath.Join(root, name), "main")
		commit := strings.TrimSpace(runGit(t, filepath.Join(root, name), "rev-parse", "HEAD"))
		members = append(members, map[string]string{"name": name, "repository_sha256": repoHash, "task_ref": task, "object_format": "sha1", "commit": commit})
	}
	parent := filepath.Join(base, "private")
	if e = os.Mkdir(parent, 0700); e != nil {
		t.Fatal(e)
	}
	result, _ := json.Marshal(superbench.WorkerResult{Version: "agentpod.superbench-worker.v2", Binding: binding, Outcome: "complete", Handoff: map[string]string{"summary": "done"}})
	marker := filepath.Join(base, "ran")
	spec := map[string]any{"version": "agentpod.superbench-worker.v2", "binding": binding, "bench_key": "fixture", "bench_id": strings.Repeat("1", 32), "workspace_root": root, "repository_name": "b", "members": members, "arguments": []string{"/bin/sh", "-c", "test \"$PWD\" = '" + filepath.Join(root, "b") + "' && test -z \"$BOARD_TOKEN$BENCH_LEASE_TOKEN\" && printf ran >> '" + marker + "' && printf '%s' '" + string(result) + "'"}, "prompt": "work", "environment": map[string]string{"LANG": "C"}, "timeout_seconds": 10}
	raw, _ := json.Marshal(spec)
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	if e = os.WriteFile(filepath.Join(parent, "request.json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	if mutate != nil {
		mutate(t, base, root, parent, spec)
	}
	indexes := map[string][]byte{}
	for _, m := range members {
		p := filepath.Join(base, "data", "mirrors", m["repository_sha256"]+".git", "worktrees", m["name"], "index")
		raw, e := os.ReadFile(p)
		if e != nil {
			t.Fatal(e)
		}
		indexes[p] = raw
	}
	executable, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	cmd := exec.CommandContext(t.Context(), executable, "-test.run=^TestGroupedWorkerCLIChild$", "--", parent, digest)
	cmd.Dir = root
	if name == "wrong-cwd" {
		cmd.Dir = base
	}
	cmd.Env = append(os.Environ(), "GROUPED_WORKER_TEST_CHILD=1", "BOARD_TOKEN=fixture-private", "BENCH_LEASE_TOKEN=fixture-private")
	output, runErr := cmd.CombinedOutput()
	for p, before := range indexes {
		after, e := os.ReadFile(p)
		if e != nil || !bytes.Equal(before, after) {
			t.Fatal("admission changed retained index", e)
		}
	}
	if refused {
		if runErr == nil {
			t.Fatal("changed source admitted")
		}
		for _, p := range []string{marker, filepath.Join(base, "filter-ran"), filepath.Join(parent, "result.json"), filepath.Join(parent, "home")} {
			if _, e := os.Lstat(p); !os.IsNotExist(e) {
				t.Fatalf("refused invocation produced effects: %s", p)
			}
		}
		if name == "changed-context" {
			if _, e := os.Lstat(filepath.Join(parent, "started")); !os.IsNotExist(e) {
				t.Fatal("changed context consumed launch")
			}
		}
		return
	}
	if runErr != nil {
		t.Fatalf("protected CLI failed: %v: %s", runErr, output)
	}
	if raw, e := os.ReadFile(marker); e != nil || string(raw) != "ran" {
		t.Fatal("bound harness did not execute", e)
	}
	if raw, e := os.ReadFile(filepath.Join(parent, "result.json")); e != nil || string(raw) != string(result) {
		t.Fatal("bound result missing", e)
	}
	repeat := exec.CommandContext(t.Context(), executable, "-test.run=^TestGroupedWorkerCLIChild$", "--", parent, digest)
	repeat.Dir = root
	repeat.Env = cmd.Env
	if e := repeat.Run(); e == nil {
		t.Fatal("context launched a second harness")
	}
	if raw, e := os.ReadFile(marker); e != nil || string(raw) != "ran" {
		t.Fatal("replay changed payload effects", e)
	}
}
func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), "/usr/bin/git", args...)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + t.TempDir(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0"}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, e := cmd.Output()
	if e != nil {
		t.Fatalf("fixture git failed: %v: %s", e, stderr.String())
	}
	return string(out)
}

func membersOf(s map[string]any) []map[string]string { return s["members"].([]map[string]string) }
