package superbench

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func workerSpec(t *testing.T) WorkerSpec {
	t.Helper()
	b := Binding{BoardID: "board", CardID: "card", RunID: "run", Epoch: 1}
	r, _ := json.Marshal(WorkerResult{Version: WorkerVersion, Binding: b, Outcome: "complete", Handoff: map[string]string{"summary": "done"}})
	return WorkerSpec{Version: WorkerVersion, Binding: b, Directory: t.TempDir(), Arguments: []string{"/bin/sh", "-c", "test -z \"$BOARD_TOKEN$BENCH_LEASE_TOKEN$GIT_CONFIG_COUNT\" && test \"$HOME\" != /inherited && printf '%s' '" + string(r) + "'"}, Environment: map[string]string{"LANG": "C"}, TimeoutSeconds: 2}
}
func contextParent(t *testing.T) string {
	t.Helper()
	p := t.TempDir()
	if e := os.Chmod(p, 0700); e != nil {
		t.Fatal(e)
	}
	p, e := filepath.EvalSymlinks(p)
	if e != nil {
		t.Fatal(e)
	}
	return p
}
func TestWorkerRealChildEnvironmentAndBoundResult(t *testing.T) {
	t.Setenv("BOARD_TOKEN", "test-marker")
	t.Setenv("BENCH_LEASE_TOKEN", "test-marker")
	t.Setenv("GIT_CONFIG_COUNT", "9")
	t.Setenv("HOME", "/inherited")
	s := workerSpec(t)
	dir, e := PrepareWorker(contextParent(t), s)
	if e != nil {
		t.Fatal(e)
	}
	if e = ExecuteWorker(context.Background(), dir); e != nil {
		t.Fatal(e)
	}
	r, e := ReadWorkerResult(dir, s.Binding)
	if e != nil || r.Handoff["summary"] != "done" {
		t.Fatal(e)
	}
	if e = ExecuteWorker(context.Background(), dir); e == nil {
		t.Fatal("one-shot request replayed")
	}
	other := s.Binding
	other.Epoch++
	if _, e = ReadWorkerResult(dir, other); e == nil {
		t.Fatal("foreign result accepted")
	}
}
func TestWorkerRejectsEnvironmentCredentialsBeforeEffects(t *testing.T) {
	s := workerSpec(t)
	s.Environment["SUPERPIPELINE_TOKEN"] = "fixture"
	parent := contextParent(t)
	if _, e := PrepareWorker(parent, s); e == nil {
		t.Fatal("credential environment accepted")
	}
	entries, _ := os.ReadDir(parent)
	if len(entries) != 0 {
		t.Fatal("effects before validation")
	}
}
func TestWorkerMalformedFailedAndOversizePreserveStarted(t *testing.T) {
	for name, command := range map[string]string{"failed": "exit 7", "wrong result": `printf '{}'`, "oversized": "head -c 70000 /dev/zero"} {
		t.Run(name, func(t *testing.T) {
			s := workerSpec(t)
			s.Arguments = []string{"/bin/sh", "-c", command}
			dir, e := PrepareWorker(contextParent(t), s)
			if e != nil {
				t.Fatal(e)
			}
			if e = ExecuteWorker(context.Background(), dir); e == nil {
				t.Fatal("invalid result accepted")
			}
			if _, e = os.Stat(filepath.Join(dir, "started")); e != nil {
				t.Fatal("lost ambiguous execution marker")
			}
			if _, e = os.Stat(filepath.Join(dir, "result.json")); !os.IsNotExist(e) {
				t.Fatal("fabricated terminal result")
			}
		})
	}
}
func TestWorkerRefusesSymlinkAndPermissiveFiles(t *testing.T) {
	s := workerSpec(t)
	dir, e := PrepareWorker(contextParent(t), s)
	if e != nil {
		t.Fatal(e)
	}
	link := filepath.Join(t.TempDir(), "link")
	if e = os.Symlink(dir, link); e != nil {
		t.Fatal(e)
	}
	if ExecuteWorker(context.Background(), link) == nil {
		t.Fatal("symlink accepted")
	}
	if e = os.Chmod(filepath.Join(dir, "request.json"), 0644); e != nil {
		t.Fatal(e)
	}
	if ExecuteWorker(context.Background(), dir) == nil {
		t.Fatal("public context accepted")
	}
}
func TestWorkerRejectsDuplicateAndUnknownResult(t *testing.T) {
	for _, raw := range []string{`{"version":"a","version":"b"}`, `{"version":"a","unknown":true}`, strings.Repeat("x", MaxWorker+1)} {
		var r WorkerResult
		if strictWorkerJSON([]byte(raw), &r) == nil {
			t.Fatal("unsafe result accepted")
		}
	}
}
