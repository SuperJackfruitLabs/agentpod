package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPluginsCommandsUseThePluginRoutes(t *testing.T) {
	bin := build(t)
	op := strings.Repeat("a", 32)
	for _, tc := range []struct {
		name   string
		args   []string
		method string
		path   string
		body   []string
	}{
		{"plan", []string{"plugins", "plan", "--station", "st", "--action", "enable"}, "POST", "/api/stations/st/plugins/plan", []string{"action", "requestId"}},
		{"show", []string{"plugins", "show", "--station", "st", "--operation", op}, "GET", "/api/stations/st/plugins/operations/" + op, nil},
		{"inspect", []string{"plugins", "inspect", "--station", "st", "--operation", op}, "POST", "/api/stations/st/plugins/operations/" + op + "/inspect", []string{}},
		{"apply", []string{"plugins", "apply", "--station", "st", "--operation", op, "--plan-digest", strings.Repeat("b", 64)}, "POST", "/api/stations/st/plugins/operations/" + op + "/apply", []string{"planDigest"}},
		{"history", []string{"plugins", "history", "--station", "st"}, "GET", "/api/stations/st/plugins/operations", nil},
		{"inventory", []string{"plugins", "inventory", "--station", "st"}, "POST", "/api/stations/st/skills/inventory", []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != tc.method || r.URL.Path != tc.path {
					t.Errorf("route = %s %s", r.Method, r.URL.Path)
				}
				if tc.body != nil {
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Errorf("decode body: %v", err)
					}
					if len(body) != len(tc.body) {
						t.Errorf("body = %v, want keys %v", body, tc.body)
					}
					for _, key := range tc.body {
						if body[key] == "" {
							t.Errorf("body lacks %s: %v", key, body)
						}
					}
				}
				_, _ = w.Write([]byte(`{"state":"planned"}`))
			}))
			defer srv.Close()
			out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}, tc.args...)
			if code != 0 || !strings.Contains(out, `"state":"planned"`) {
				t.Fatalf("%s failed (%d): %s", tc.name, code, out)
			}
		})
	}
	if _, code := run(t, bin, nil, "plugins", "plan", "--station", "st", "--action", "activate"); code != 2 {
		t.Fatalf("an unknown action exited %d", code)
	}
}
