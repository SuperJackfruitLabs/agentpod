package main

import (
	"encoding/json"
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
