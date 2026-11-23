package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
	// --keep-bench is sent only when given, both ways, so another `set` never resets the stage's choice.
	for args, want := range map[string]string{"--keep-bench": `{"keepBench":true}`, "--keep-bench=false": `{"keepBench":false}`} {
		if _, code := run(t, bin, env, "bench", "stage", "set", "review", args); code != 0 {
			t.Fatalf("%s: exit = %d", args, code)
		}
		if _, _, _, body, _ = rec.snapshot(); mustJSON(t, body) != want {
			t.Errorf("%s: body %v", args, body)
		}
	}
}

// TestBenchStageCardsChoose: --cards-choose and --default-repo mark a stage whose cards choose its
// repositories; on set, only what is given is sent, and --cards-choose=false or --no-default-repo
// turn them off.
func TestBenchStageCardsChoose(t *testing.T) {
	bin := build(t)
	rec := &recorded{}
	srv := rec.server(t, `{"ok":true}`)
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
	if _, code := run(t, bin, env, "bench", "stage", "add", "review", "--board", "brd_0123456789abcdef", "--station", "st_1",
		"--agent", "agt_abc123", "--checkpoint-repo", "app", "--worker", "/w", "--cards-choose", "--default-repo", "app",
		"--repo", "name=api,provider=forge,repository=o/api,clone=/r/api", "--repo", "name=app,provider=forge,repository=o/app,clone=/r/app"); code != 0 {
		t.Fatalf("add: exit = %d", code)
	}
	if _, _, _, body, _ := rec.snapshot(); body["cardsChoose"] != true || mustJSON(t, body["defaultRepositories"]) != `["app"]` {
		t.Errorf("add body %v", body)
	}
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"--cards-choose"}, `{"cardsChoose":true}`},
		{[]string{"--cards-choose=false"}, `{"cardsChoose":false}`},
		{[]string{"--default-repo", "api", "--default-repo", "app"}, `{"defaultRepositories":["api","app"]}`},
		{[]string{"--no-default-repo"}, `{"defaultRepositories":[]}`},
	} {
		if _, code := run(t, bin, env, append([]string{"bench", "stage", "set", "review"}, c.args...)...); code != 0 {
			t.Fatalf("%v: exit = %d", c.args, code)
		}
		if _, _, _, body, _ := rec.snapshot(); mustJSON(t, body) != c.want {
			t.Errorf("%v: body %v, want %s", c.args, body, c.want)
		}
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
		"set, default and none": {"bench", "stage", "set", "review", "--default-repo", "app", "--no-default-repo"},
		"add, no default":       append(append([]string{"bench", "stage", "add", "review", "--no-default-repo"}, full...), "--repo", "name=app,provider=forge,repository=o/a,clone=/r"),
		"rm, no name":           {"bench", "stage", "rm"},
		"doctor, nothing":       {"bench", "doctor"},
		"doctor, both":          {"bench", "doctor", "review", "--station", "st_1"},
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

// TestBenchDoctorPrintsPassAndFailLines: one line per check, a failure's next step under it, the
// manual steps, and exit 1 when anything failed.
func TestBenchDoctorPrintsPassAndFailLines(t *testing.T) {
	bin := build(t)
	rec := &recorded{}
	srv := rec.server(t, `{"ok":false,"checks":[
		{"check":"hub: checkpoint coordinator","ok":true,"detail":"PROPOSED_CHECKPOINT_COORDINATOR=true"},
		{"check":"benchd: reachable","ok":false,"detail":"the bench daemon did not answer","next":"Host step: start benchd"},
		{"check":"benchd: storage","ok":null,"detail":"not checked"},
		{"check":"stage: SuperPipeline stage","ok":null,"warn":true,"detail":"no stage id","next":"fleet bench stage set review --stage-id STAGE_ID"}],
		"manual":["SuperPipeline: link the board agent"],"checkpointPolicy":{"kind":"superbench"}}`)
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
	out, code := run(t, bin, env, "bench", "doctor", "--station", "st_1")
	if code != 1 {
		t.Fatalf("exit = %d, want 1 for a failed check", code)
	}
	_, path, query, _, _ := rec.snapshot()
	if path != "/api/admin/bench/doctor" || query != "station=st_1" {
		t.Errorf("asked %s?%s", path, query)
	}
	for _, line := range []string{"PASS  hub: checkpoint coordinator", "FAIL  benchd: reachable", "      next: Host step: start benchd",
		"SKIP  benchd: storage", "WARN  stage: SuperPipeline stage", "      next: fleet bench stage set review --stage-id STAGE_ID", "Manual steps", "  - SuperPipeline: link the board agent", "The stage's checkpointPolicy for SuperPipeline:", `"kind": "superbench"`} {
		if !strings.Contains(out, line) {
			t.Errorf("output lacks %q:\n%s", line, out)
		}
	}
	if strings.Contains(out, "next: Host step: start benchd\n      next") {
		t.Error("a passing check printed a next step")
	}
}

// TestBenchDoctorNamesTheCardPolicyField: a stage whose cards choose reports its policy as
// cardCheckpointPolicy, and the doctor prints it under that name, the SuperPipeline field it goes in;
// a person copies the name with the value.
func TestBenchDoctorNamesTheCardPolicyField(t *testing.T) {
	bin := build(t)
	rec := &recorded{}
	srv := rec.server(t, `{"ok":true,"checks":[{"check":"hub: checkpoint coordinator","ok":true,"detail":"on"}],
		"manual":[],"cardCheckpointPolicy":{"version":"superpipeline.checkpoint-policy.v2"}}`)
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
	out, code := run(t, bin, env, "bench", "doctor", "review")
	if code != 0 {
		t.Fatalf("exit = %d, want 0:\n%s", code, out)
	}
	if !strings.Contains(out, "The stage's cardCheckpointPolicy for SuperPipeline:") || !strings.Contains(out, `"superpipeline.checkpoint-policy.v2"`) {
		t.Errorf("the card policy is not printed under its field:\n%s", out)
	}
	if strings.Contains(out, "The stage's checkpointPolicy") {
		t.Errorf("a card stage's policy was named checkpointPolicy:\n%s", out)
	}
}
