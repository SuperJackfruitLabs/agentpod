package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestBridgeRelatedWorkPutsTheSwitch pins `fleet bridge related-work` to its route, method and
// body: one boolean, true for on and false for off, at the board's own path.
func TestBridgeRelatedWorkPutsTheSwitch(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		state string
		want  bool
	}{{"off", false}, {"on", true}} {
		t.Run(tc.state, func(t *testing.T) {
			var method, path string
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				method, path = r.Method, r.URL.Path
				_ = json.NewDecoder(r.Body).Decode(&body)
				_, _ = w.Write([]byte(`{"boardId":"brd_0000000000000001","relatedWork":false}`))
			}))
			defer srv.Close()
			_, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
				"bridge", "related-work", "brd_0000000000000001", tc.state)
			if code != 0 {
				t.Fatalf("exit = %d", code)
			}
			if method != http.MethodPut || path != "/api/admin/bridge/boards/brd_0000000000000001" {
				t.Errorf("called %s %s, want PUT /api/admin/bridge/boards/brd_0000000000000001", method, path)
			}
			if len(body) != 1 || body["relatedWork"] != tc.want {
				t.Errorf("body = %v, want exactly {relatedWork: %v}", body, tc.want)
			}
		})
	}
}

// TestBridgeRelatedWorkRefusesAnythingButOnOrOff: "maybe" is not a setting, and a missing state
// is not "on". Both exit 2 and never reach the hub.
func TestBridgeRelatedWorkRefusesAnythingButOnOrOff(t *testing.T) {
	bin := build(t)
	for _, args := range [][]string{
		{"bridge", "related-work", "brd_0000000000000001", "maybe"},
		{"bridge", "related-work", "brd_0000000000000001"},
		{"bridge", "related-work"},
	} {
		called := false
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			_, _ = w.Write([]byte(`{}`))
		}))
		_, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}, args...)
		srv.Close()
		if code != 2 {
			t.Errorf("%v: exit = %d, want 2", args, code)
		}
		if called {
			t.Errorf("%v: sent a request; a refused setting should never leave the client", args)
		}
	}
}
