package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type recorded struct {
	mu     sync.Mutex
	method string
	path   string
	query  string
	body   map[string]any
	calls  int
}

func (r *recorded) server(t *testing.T, reply string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var got map[string]any
		_ = json.NewDecoder(req.Body).Decode(&got)
		r.mu.Lock()
		r.method, r.path, r.query, r.body = req.Method, req.URL.Path, req.URL.RawQuery, got
		r.calls++
		r.mu.Unlock()
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (r *recorded) snapshot() (string, string, string, map[string]any, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.method, r.path, r.query, r.body, r.calls
}

// TestBenchStageAddSendsTheWholeStage: every flag lands in its field, --repo specs become
// repository objects, and --worker with its arguments becomes the worker command.
func TestBenchStageAddSendsTheWholeStage(t *testing.T) {
	bin := build(t)
	rec := &recorded{}
	srv := rec.server(t, `{"ok":true}`)
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
	_, code := run(t, bin, env, "bench", "stage", "add", "review", "--board", "brd_0123456789abcdef", "--station", "st_1",
		"--agent", "agt_abc123", "--checkpoint-repo", "app",
		"--repo", "name=app,provider=forge,repository=o/app,clone=ssh://git@forge.test:2222/o/app.git,base=main",
		"--repo", "name=lib,provider=github,repository=o/lib,clone=https://github.com/o/lib.git,format=sha256",
		"--worker", "/usr/libexec/w", "--worker-arg", "--fast", "--env", "LANG=C.UTF-8", "--launch", "registered-v1",
		"--source-tenant", "tnt_1", "--stage-id", "stg_review", "--bridge-key", "bench-review", "--repin")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	method, path, _, body, _ := rec.snapshot()
	if method != http.MethodPost || path != "/api/admin/bench/stages" {
		t.Fatalf("called %s %s", method, path)
	}
	want := map[string]any{
		"name": "review", "boardId": "brd_0123456789abcdef", "stationId": "st_1", "agentId": "agt_abc123", "checkpointRepository": "app",
		"sourceTenantId": "tnt_1", "stageId": "stg_review", "bridgeKey": "bench-review", "repin": true,
		"repositories": []any{
			map[string]any{"name": "app", "provider": "forge", "repository": "o/app", "cloneUrl": "ssh://git@forge.test:2222/o/app.git", "base": "main"},
			map[string]any{"name": "lib", "provider": "github", "repository": "o/lib", "cloneUrl": "https://github.com/o/lib.git", "objectFormat": "sha256"},
		},
		"worker": map[string]any{"arguments": []any{"/usr/libexec/w", "--fast"}, "environment": map[string]any{"LANG": "C.UTF-8"}, "launch": "registered-v1"},
	}
	if mustJSON(t, body) != mustJSON(t, want) {
		t.Errorf("body = %s\nwant   %s", mustJSON(t, body), mustJSON(t, want))
	}
}

// TestBenchStageSetSendsOnlyWhatWasAsked: moving a stage's board is a PATCH naming the board and
// nothing else, so the node keeps its repositories and worker as installed.
func TestBenchStageSetSendsOnlyWhatWasAsked(t *testing.T) {
	bin := build(t)
	rec := &recorded{}
	srv := rec.server(t, `{"ok":true}`)
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
	if _, code := run(t, bin, env, "bench", "stage", "set", "review", "--board", "brd_fedcba9876543210"); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	_, path, _, body, _ := rec.snapshot()
	if path != "/api/admin/bench/stages/review" || mustJSON(t, body) != `{"boardId":"brd_fedcba9876543210"}` {
		t.Errorf("PATCH %s %v", path, body)
	}
	if _, code := run(t, bin, env, "bench", "stage", "set", "review", "--refresh"); code != 0 {
		t.Fatalf("refresh: exit = %d", code)
	}
	if _, _, _, body, _ = rec.snapshot(); mustJSON(t, body) != `{"refresh":true}` {
		t.Errorf("refresh body %v", body)
	}
}

func TestBenchRefusalsNeverLeaveTheClient(t *testing.T) {
	bin := build(t)
	rec := &recorded{}
	srv := rec.server(t, `{"ok":true}`)
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
	full := []string{"--board", "brd_1", "--station", "st_1", "--agent", "agt_1", "--checkpoint-repo", "app", "--worker", "/w"}
	for name, args := range map[string][]string{
		"add, no name":          append([]string{"bench", "stage", "add"}, full...),
		"add, no repo":          append([]string{"bench", "stage", "add", "review"}, full...),
		"add, half a repo":      append(append([]string{"bench", "stage", "add", "review"}, full...), "--repo", "name=app,provider=forge"),
		"add, unknown repo key": append(append([]string{"bench", "stage", "add", "review"}, full...), "--repo", "name=app,provider=forge,repository=o/a,clone=/r,token=x"),
		"add, refresh":          append(append([]string{"bench", "stage", "add", "review", "--refresh"}, full...), "--repo", "name=app,provider=forge,repository=o/a,clone=/r"),
		"set, nothing":          {"bench", "stage", "set", "review"},
		"set, args no worker":   {"bench", "stage", "set", "review", "--worker-arg", "x"},
		"set, bridge key":       {"bench", "stage", "set", "review", "--bridge-key", "k"},
		"rm, no name":           {"bench", "stage", "rm"},
		"unknown verb":          {"bench", "stage", "move"},
	} {
		if _, code := run(t, bin, env, args...); code != 2 {
			t.Errorf("%s: exit = %d, want 2", name, code)
		}
	}
	if _, _, _, _, calls := rec.snapshot(); calls != 0 {
		t.Errorf("%d refused invocations reached the hub", calls)
	}
}
