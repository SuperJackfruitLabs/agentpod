package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// TestAdminVerbsUseTheHubRoutes pins each new verb to the route it is supposed to call.
//
// Method AND path, because a verb that reaches the right path with the wrong method is the
// failure these verbs are most likely to have: they are thin wrappers, so the only thing that
// can really be wrong is which endpoint they picked.
func TestAdminVerbsUseTheHubRoutes(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		name   string
		args   []string
		method string
		path   string
	}{
		// the roster — the gate on an agent claiming anything at all
		{"bridge list", []string{"bridge", "list"}, "GET", "/api/admin/bridge/agents"},
		{"bridge add", []string{"bridge", "add", "--key", "k", "--board", "brd_1", "--station", "st_1", "--token", "spa_x"}, "POST", "/api/admin/bridge/agents"},
		{"bridge set", []string{"bridge", "set", "k", "--board", "brd_2"}, "PATCH", "/api/admin/bridge/agents/k"},
		{"bridge rm", []string{"bridge", "rm", "k"}, "DELETE", "/api/admin/bridge/agents/k"},
		{"bridge checkpoint-attempts", []string{"bridge", "checkpoint-attempts"}, "GET", "/api/admin/checkpoint/attempts"},
		{"bridge checkpoint-settle", []string{"bridge", "checkpoint-settle", "attempt_1", "--evidence", "node journal shows the record cancelled"}, "POST", "/api/admin/checkpoint/attempts/attempt_1/settle"},

		// bench stages and the doctor
		{"bench stage list", []string{"bench", "stage", "list"}, "GET", "/api/admin/bench/stages"},
		{"bench stage add", []string{"bench", "stage", "add", "review", "--board", "brd_1", "--station", "st_1", "--agent", "agt_1",
			"--repo", "name=app,provider=forge,repository=o/app,clone=ssh://git@forge.test/o/app.git", "--checkpoint-repo", "app",
			"--worker", "/usr/libexec/w"}, "POST", "/api/admin/bench/stages"},
		{"bench stage add remote", []string{"bench", "stage", "add", "review", "--board", "brd_1", "--station", "st_1", "--agent", "agt_1",
			"--repo", "name=app,provider=forge,repository=o/app,clone=ssh://git@forge.test/o/app.git", "--checkpoint-repo", "app",
			"--execution", "remote", "--bench-node", "node_x"}, "POST", "/api/admin/bench/stages"},
		{"bench stage set", []string{"bench", "stage", "set", "review", "--board", "brd_2"}, "PATCH", "/api/admin/bench/stages/review"},
		{"bench stage rm", []string{"bench", "stage", "rm", "review"}, "DELETE", "/api/admin/bench/stages/review"},
		{"bench doctor", []string{"bench", "doctor", "review"}, "GET", "/api/admin/bench/doctor"},

		{"grants list", []string{"grants", "list"}, "GET", "/api/admin/grants"},
		{"grants show", []string{"grants", "show", "prn_1"}, "GET", "/api/admin/grants/prn_1"},
		{"grants rm", []string{"grants", "rm", "prn_1"}, "DELETE", "/api/admin/grants/prn_1"},

		{"principals list", []string{"principals", "list"}, "GET", "/api/admin/principals"},
		{"principals suspend", []string{"principals", "suspend", "prn_1"}, "POST", "/api/admin/principals/prn_1/suspend"},
		{"principals restore", []string{"principals", "restore", "prn_1"}, "POST", "/api/admin/principals/prn_1/restore"},
		{"principals add-service", []string{"principals", "add-service", "superwitness", "--client", "superwitness", "--scope", "evidence:read"}, "POST", "/api/admin/service-principals"},
		{"principals revoke-credential", []string{"principals", "revoke-credential", "svc_1"}, "POST", "/api/admin/service-principals/credentials/svc_1/revoke"},
		{"principals add-credential", []string{"principals", "add-credential", "prn_1", "--client", "superwitness"}, "POST", "/api/admin/service-principals/prn_1/credentials"},

		{"users list", []string{"users", "list"}, "GET", "/api/admin/users"},
		{"users show", []string{"users", "show", "u1"}, "GET", "/api/admin/users/u1"},
		{"users ban", []string{"users", "ban", "u1", "--reason", "spam"}, "POST", "/api/admin/users/u1/ban"},
		{"users unban", []string{"users", "unban", "u1"}, "POST", "/api/admin/users/u1/unban"},
		{"users role", []string{"users", "role", "u1", "--role", "admin"}, "PUT", "/api/admin/users/u1/role"},

		{"runtimes list", []string{"runtimes", "list"}, "GET", "/api/runtimes"},
		{"runtimes providers", []string{"runtimes", "providers"}, "GET", "/api/runtimes/providers"},
		{"runtimes start", []string{"runtimes", "start", "rt_1"}, "POST", "/api/runtimes/rt_1/start"},
		{"runtimes stop", []string{"runtimes", "stop", "rt_1"}, "POST", "/api/runtimes/rt_1/stop"},
		{"runtimes rm", []string{"runtimes", "rm", "rt_1"}, "DELETE", "/api/runtimes/rt_1"},

		{"invite", []string{"invite", "--label", "laptop"}, "POST", "/api/enrollment-tokens"},

		{"station lifecycle", []string{"station", "lifecycle", "--station", "st_1", "--action", "restart"}, "POST", "/api/stations/st_1/lifecycle"},
		{"station cleanup plan", []string{"station", "cleanup", "plan", "--station", "st_1"}, "POST", "/api/stations/st_1/cleanup/plan"},
		{"station cleanup apply", []string{"station", "cleanup", "apply", "--station", "st_1", "--path", "/tmp/a"}, "POST", "/api/stations/st_1/cleanup/apply"},
		{"station changeset status", []string{"station", "changeset", "status", "--station", "st_1"}, "POST", "/api/stations/st_1/changeset/status"},
		{"station changeset diff", []string{"station", "changeset", "diff", "--station", "st_1", "--side", "committed"}, "POST", "/api/stations/st_1/changeset/diff"},
		{"station fs mkdir", []string{"station", "fs", "mkdir", "--station", "st_1", "--path", "/tmp/d"}, "POST", "/api/stations/st_1/fs/mkdir"},
		{"station fs move", []string{"station", "fs", "move", "--station", "st_1", "--from", "/a", "--to", "/b"}, "POST", "/api/stations/st_1/fs/move"},
		{"station fs delete", []string{"station", "fs", "delete", "--station", "st_1", "--path", "/tmp/d"}, "POST", "/api/stations/st_1/fs/delete"},

		{"staff options", []string{"staff", "options"}, "GET", "/api/admin/station-setup/options"},
		{"staff unassign", []string{"staff", "unassign", "--station", "st_1"}, "DELETE", "/api/admin/stations/st_1/agent"},

		{"settings show", []string{"settings", "show"}, "GET", "/api/admin/settings"},
		{"settings signup read", []string{"settings", "signup"}, "GET", "/api/admin/settings/signup"},
		{"settings signup enable", []string{"settings", "signup", "enable"}, "POST", "/api/admin/settings/signup/enable"},
		{"settings signup disable", []string{"settings", "signup", "disable"}, "POST", "/api/admin/settings/signup/disable"},
		{"settings transcription read", []string{"settings", "transcription"}, "GET", "/api/admin/settings/transcription"},
		{"settings transcription test", []string{"settings", "transcription", "test"}, "POST", "/api/admin/settings/transcription/test"},
		{"settings speech read", []string{"settings", "speech"}, "GET", "/api/admin/settings/speech"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gotMethod, gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod, gotPath = r.Method, r.URL.Path
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer srv.Close()
			_, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}, tc.args...)
			if code != 0 {
				t.Fatalf("exit = %d", code)
			}
			if gotMethod != tc.method || gotPath != tc.path {
				t.Errorf("called %s %s, want %s %s", gotMethod, gotPath, tc.method, tc.path)
			}
		})
	}
}

// TestBridgeSetSendsOnlyWhatWasAsked is the property that makes `bridge set` safe to use on a
// live roster row: a PATCH naming fields the caller did not pass would overwrite them.
//
// This is the whole reason `set` takes separate flags rather than a row document — so repointing
// an agent at a new board cannot silently blank its credentials.
func TestBridgeSetSendsOnlyWhatWasAsked(t *testing.T) {
	bin := build(t)
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	_, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"bridge", "set", "k", "--board", "brd_2")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if len(body) != 1 || body["boardId"] != "brd_2" {
		t.Errorf("body = %v, want exactly {boardId: brd_2}", body)
	}
}

// TestBridgeSetRefusesAnEmptyPatch: a PATCH with no fields answers 200 and changes nothing,
// which reads to a caller as success. Refusing is the difference between "done" and "nothing
// happened" — and a script that cannot tell those apart will not notice it stopped working.
func TestBridgeSetRefusesAnEmptyPatch(t *testing.T) {
	bin := build(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	_, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"bridge", "set", "k")
	if code == 0 {
		t.Errorf("exit = 0, want a usage refusal")
	}
	if called {
		t.Errorf("sent a request for an empty patch; it should never leave the client")
	}
}

// TestBridgeSetCredentialSource: the supported way to give an existing token row a plane
// credential source. The PATCH carries exactly the source and nothing else, so no other field of
// the live row is overwritten.
func TestBridgeSetCredentialSource(t *testing.T) {
	bin := build(t)
	// The fleet binary is a subprocess, so the race detector cannot see the request finish before
	// the test reads what the handler stored; the mutex is that edge.
	var mu sync.Mutex
	var body map[string]any
	var method, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var got map[string]any
		_ = json.NewDecoder(r.Body).Decode(&got)
		mu.Lock()
		method, path, body = r.Method, r.URL.Path, got
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
	read := func() (string, string, map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		return method, path, body
	}

	_, code := run(t, bin, env, "bridge", "set", "k", "--credential-source", "station-plane",
		"--principal", "prn_aaaaaaaaaaaaaaaaaaaa", "--organization", "org_bbbbbbbbbbbbbbbbbbbb",
		"--audience", "https://staging-app.superpipeline.dev")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	m, p, b := read()
	if m != http.MethodPatch || p != "/api/admin/bridge/agents/k" {
		t.Errorf("called %s %s", m, p)
	}
	want := map[string]any{"version": float64(1), "kind": "station-plane", "principalId": "prn_aaaaaaaaaaaaaaaaaaaa",
		"organizationId": "org_bbbbbbbbbbbbbbbbbbbb", "audience": "https://staging-app.superpipeline.dev"}
	source, _ := b["credentialSource"].(map[string]any)
	if len(b) != 1 || len(source) != len(want) {
		t.Fatalf("body = %v, want exactly {credentialSource: %v}", b, want)
	}
	for k, v := range want {
		if source[k] != v {
			t.Errorf("credentialSource[%s] = %v, want %v", k, source[k], v)
		}
	}

	_, code = run(t, bin, env, "bridge", "set", "k", "--credential-source", "none", "--token", "spa_x")
	if code != 0 {
		t.Fatalf("none: exit = %d", code)
	}
	_, _, b = read()
	if v, ok := b["credentialSource"]; !ok || v != nil || b["token"] != "spa_x" || len(b) != 2 {
		t.Errorf("none: body = %v, want {credentialSource: null, token: spa_x}", b)
	}
}

// TestBridgeSetCredentialSourceRefusesAPartialSource: a half-typed source never leaves the client.
func TestBridgeSetCredentialSourceRefusesAPartialSource(t *testing.T) {
	bin := build(t)
	var mu sync.Mutex
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		called = true
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
	for name, args := range map[string][]string{
		"no audience":    {"--credential-source", "station-plane", "--principal", "prn_a", "--organization", "org_b"},
		"no kind":        {"--principal", "prn_a", "--organization", "org_b", "--audience", "https://a.test"},
		"unknown kind":   {"--credential-source", "token", "--token", "spa_x"},
		"none, no token": {"--credential-source", "none"},
		"none, identity": {"--credential-source", "none", "--token", "spa_x", "--principal", "prn_a"},
	} {
		if _, code := run(t, bin, env, append([]string{"bridge", "set", "k"}, args...)...); code != 2 {
			t.Errorf("%s: exit = %d, want 2", name, code)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if called {
		t.Errorf("sent a request for a partial credential source")
	}
}

// TestBridgeAddStationPlaneNeedsNoToken: a source row is added with no claim token, and with no
// identity flags the hub is asked to derive them. A token on a source row, or a source the CLI
// does not know, never leaves the client.
func TestBridgeAddStationPlaneNeedsNoToken(t *testing.T) {
	bin := build(t)
	var mu sync.Mutex
	var body map[string]any
	var method, path string
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var got map[string]any
		_ = json.NewDecoder(r.Body).Decode(&got)
		mu.Lock()
		method, path, body = r.Method, r.URL.Path, got
		calls++
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}

	_, code := run(t, bin, env, "bridge", "add", "--key", "bench", "--board", "brd_1", "--station", "st_1",
		"--credential-source", "station-plane", "--mcp-token", "spa_run")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	mu.Lock()
	if method != http.MethodPost || path != "/api/admin/bridge/agents" {
		t.Errorf("called %s %s", method, path)
	}
	want := map[string]any{"key": "bench", "boardId": "brd_1", "stationId": "st_1", "mcpToken": "spa_run",
		"credentialSource": map[string]any{"version": float64(1), "kind": "station-plane"}}
	if got, _ := json.Marshal(body); string(got) != mustJSON(t, want) {
		t.Errorf("body = %s, want %s", got, mustJSON(t, want))
	}
	mu.Unlock()

	_, code = run(t, bin, env, "bridge", "set", "bench", "--credential-source", "station-plane")
	if code != 0 {
		t.Fatalf("set: exit = %d", code)
	}
	mu.Lock()
	if got, _ := json.Marshal(body); string(got) != `{"credentialSource":{"kind":"station-plane","version":1}}` {
		t.Errorf("set: body = %s", got)
	}
	before := calls
	mu.Unlock()

	for name, args := range map[string][]string{
		"source and token": {"--credential-source", "station-plane", "--token", "spa_x"},
		"none":             {"--credential-source", "none", "--token", "spa_x"},
		"no token at all":  {},
		"half an identity": {"--credential-source", "station-plane", "--principal", "prn_a"},
	} {
		base := []string{"bridge", "add", "--key", "bench", "--board", "brd_1", "--station", "st_1"}
		if _, code := run(t, bin, env, append(base, args...)...); code != 2 {
			t.Errorf("%s: exit = %d, want 2", name, code)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != before {
		t.Errorf("a refused add reached the hub")
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestUsersBanRequiresAReason — a ban nobody recorded a reason for is one nobody can review,
// and the person lifting it will not be the person who applied it.
func TestUsersBanRequiresAReason(t *testing.T) {
	bin := build(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	_, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"users", "ban", "u1")
	if code == 0 || called {
		t.Errorf("ban without --reason: exit=%d, requestSent=%v — want a refusal, no request", code, called)
	}
}

// TestSignupWithNoDirectionReads is the property that stops a forgotten argument reopening
// signup on a live hub: `fleet settings signup` is a read, and each direction has to be named.
func TestSignupWithNoDirectionReads(t *testing.T) {
	bin := build(t)
	var method string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		_, _ = w.Write([]byte(`{"open":false}`))
	}))
	defer srv.Close()
	_, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"settings", "signup")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if method != "GET" {
		t.Errorf("bare `settings signup` used %s — it must read, never toggle", method)
	}
}

// TestPrincipalsAddCredentialSendsTheClient pins the body, not only the route: the hub refuses a
// credential with no client, and the client is what decides where its tokens may be spent.
func TestPrincipalsAddCredentialSendsTheClient(t *testing.T) {
	bin := build(t)
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"credential":{"id":"svc_1"}}`))
	}))
	defer srv.Close()
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}

	if _, code := run(t, bin, env, "principals", "add-credential", "prn_1", "--client", "superwitness"); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if got["oauthClient"] != "superwitness" {
		t.Errorf("body = %v, want oauthClient superwitness", got)
	}

	if _, code := run(t, bin, env, "principals", "add-credential", "prn_1"); code != 2 {
		t.Errorf("add-credential without --client: exit = %d, want 2", code)
	}
}

// TestBridgeCheckpointSettleRefusesWithoutEvidence: a settlement with no evidence never leaves the
// client. Settling ends an attempt the hub could not prove resolved; it must say why.
func TestBridgeCheckpointSettleRefusesWithoutEvidence(t *testing.T) {
	bin := build(t)
	var mu sync.Mutex
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		called = true
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	env := []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
	for name, args := range map[string][]string{
		"no attempt":     {"bridge", "checkpoint-settle"},
		"no evidence":    {"bridge", "checkpoint-settle", "attempt_1"},
		"short evidence": {"bridge", "checkpoint-settle", "attempt_1", "--evidence", "looked"},
	} {
		if _, code := run(t, bin, env, args...); code != 2 {
			t.Errorf("%s: exit = %d, want 2", name, code)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if called {
		t.Errorf("sent a settlement without evidence")
	}
}
