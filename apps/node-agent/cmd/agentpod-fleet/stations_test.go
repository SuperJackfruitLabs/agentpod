package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Each verb must reach the route the Console uses, with the method the hub
// expects. A station the node detects is not an agent until it is adopted, and
// only an adopted station carries the ID every skills verb needs.
func TestStationsVerbsReachTheAdoptionRoutes(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		name   string
		args   []string
		method string
		path   string
	}{
		{"detected", []string{"stations", "detected", "--node", "node_fixture"}, http.MethodGet, "/api/nodes/node_fixture/detected"},
		{"list", []string{"stations", "list", "--node", "node_fixture"}, http.MethodGet, "/api/nodes/node_fixture/stations"},
		{"adopt", []string{"stations", "adopt", "--node", "node_fixture", "--key", "pi:abc"}, http.MethodPost, "/api/nodes/node_fixture/stations/adopt"},
		{"unadopt", []string{"stations", "unadopt", "--station", "station_fixture"}, http.MethodDelete, "/api/stations/station_fixture"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gotMethod, gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod, gotPath = r.Method, r.URL.Path
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer srv.Close()
			out, code := run(t, bin, []string{
				"AGENTPOD_HUB=" + srv.URL,
				"AGENTPOD_TOKEN=" + jwtish("prn_operator", "human"),
			}, tc.args...)
			if code != 0 {
				t.Fatalf("exit %d: %s", code, out)
			}
			if gotMethod != tc.method || gotPath != tc.path {
				t.Fatalf("reached %s %s, wanted %s %s", gotMethod, gotPath, tc.method, tc.path)
			}
		})
	}
}

// Adopting several stations is one reviewed call, and the keys arrive as the
// hub's schema expects rather than as a joined string.
func TestStationsAdoptSendsEveryKeyAsAList(t *testing.T) {
	bin := build(t)
	var body struct {
		Keys []string `json:"keys"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{
		"AGENTPOD_HUB=" + srv.URL,
		"AGENTPOD_TOKEN=" + jwtish("prn_operator", "human"),
	}, "stations", "adopt", "--node", "node_fixture", "--key", "pi:abc", "--key", "opencode:def")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if len(body.Keys) != 2 || body.Keys[0] != "pi:abc" || body.Keys[1] != "opencode:def" {
		t.Fatalf("keys did not arrive as a list: %+v", body.Keys)
	}
}

// A verb that needs a node or a station says which, rather than calling the
// hub with an empty path segment.
func TestStationsRefusesIncompleteArguments(t *testing.T) {
	bin := build(t)
	for _, args := range [][]string{
		{"stations", "detected"},
		{"stations", "list"},
		{"stations", "adopt", "--node", "node_fixture"},
		{"stations", "adopt", "--key", "pi:abc"},
		{"stations", "unadopt"},
		{"stations", "wat", "--node", "node_fixture"},
	} {
		out, code := run(t, bin, []string{
			"AGENTPOD_HUB=http://127.0.0.1:1",
			"AGENTPOD_TOKEN=" + jwtish("prn_operator", "human"),
		}, args...)
		if code == 0 {
			t.Fatalf("%v was accepted: %s", args, out)
		}
		if strings.TrimSpace(out) == "" {
			t.Fatalf("%v failed silently", args)
		}
	}
}

// Push access is granted per station through the hub's own route, so an operator never has to
// reach for curl and never has to hold the forge admin token to do it.
func TestStationsPushAccessVerbsReachTheGitIdentityRoute(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		name   string
		args   []string
		method string
	}{
		{"show", []string{"stations", "git-identity", "--station", "station_fixture"}, http.MethodGet},
		{"grant", []string{"stations", "grant-push", "--station", "station_fixture"}, http.MethodPost},
		{"revoke", []string{"stations", "revoke-push", "--station", "station_fixture"}, http.MethodDelete},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gotMethod, gotPath, gotBody string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod, gotPath = r.Method, r.URL.Path
				b, _ := io.ReadAll(r.Body)
				gotBody = string(b)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer srv.Close()
			out, code := run(t, bin, []string{
				"AGENTPOD_HUB=" + srv.URL,
				"AGENTPOD_TOKEN=" + jwtish("prn_operator", "human"),
			}, tc.args...)
			if code != 0 {
				t.Fatalf("exit %d: %s", code, out)
			}
			if gotMethod != tc.method {
				t.Errorf("method = %s, want %s", gotMethod, tc.method)
			}
			if gotPath != "/api/stations/station_fixture/git-identity" {
				t.Errorf("path = %s, want /api/stations/station_fixture/git-identity", gotPath)
			}
			// Nothing is sent: an operator who could name the account could aim a key at another
			// agent, and the key itself is the node's to generate.
			if strings.Contains(gotBody, "username") || strings.Contains(gotBody, "publicKey") {
				t.Errorf("body carried something the caller should not supply: %s", gotBody)
			}
		})
	}
}

// A verb that silently acted on nothing would be worse than one that refuses.
func TestStationsPushAccessVerbsRequireAStation(t *testing.T) {
	bin := build(t)
	for _, verb := range []string{"git-identity", "grant-push", "revoke-push"} {
		t.Run(verb, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Errorf("%s with no --station reached the hub: %s %s", verb, r.Method, r.URL.Path)
			}))
			defer srv.Close()
			out, code := run(t, bin, []string{
				"AGENTPOD_HUB=" + srv.URL,
				"AGENTPOD_TOKEN=" + jwtish("prn_operator", "human"),
			}, "stations", verb)
			if code == 0 {
				t.Fatalf("exit 0 with no --station: %s", out)
			}
			if !strings.Contains(out, "--station") {
				t.Errorf("the refusal does not say what is missing: %s", out)
			}
		})
	}
}
