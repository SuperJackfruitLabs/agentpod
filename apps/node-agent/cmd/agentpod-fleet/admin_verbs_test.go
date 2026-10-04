package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

		{"grants list", []string{"grants", "list"}, "GET", "/api/admin/grants"},
		{"grants show", []string{"grants", "show", "prn_1"}, "GET", "/api/admin/grants/prn_1"},
		{"grants rm", []string{"grants", "rm", "prn_1"}, "DELETE", "/api/admin/grants/prn_1"},

		{"principals list", []string{"principals", "list"}, "GET", "/api/admin/principals"},
		{"principals suspend", []string{"principals", "suspend", "prn_1"}, "POST", "/api/admin/principals/prn_1/suspend"},
		{"principals restore", []string{"principals", "restore", "prn_1"}, "POST", "/api/admin/principals/prn_1/restore"},
		{"principals add-service", []string{"principals", "add-service", "superwitness", "--client", "superwitness", "--scope", "evidence:read"}, "POST", "/api/admin/service-principals"},
		{"principals revoke-credential", []string{"principals", "revoke-credential", "svc_1"}, "POST", "/api/admin/service-principals/credentials/svc_1/revoke"},

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
