package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestMCPProxyCommandsSendWhatTheHubExpects(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		name   string
		args   []string
		method string
		path   string
		body   map[string]any
	}{
		{"list", []string{"mcp-proxy", "list"}, "GET", "/api/fleet/mcp-proxy", nil},
		{"list node", []string{"mcp-proxy", "list", "--node", "nod_1"}, "GET", "/api/fleet/mcp-proxy?nodeId=nod_1", nil},
		{"enable", []string{"mcp-proxy", "enable", "st_a", "st_b"}, "POST", "/api/fleet/mcp-proxy", map[string]any{"action": "enable", "stationIds": []any{"st_a", "st_b"}}},
		{"enable all", []string{"mcp-proxy", "enable", "--all-eligible", "--node", "nod_1"}, "POST", "/api/fleet/mcp-proxy", map[string]any{"action": "enable", "allEligible": true, "nodeId": "nod_1"}},
		{"disable", []string{"mcp-proxy", "disable", "st_a"}, "POST", "/api/fleet/mcp-proxy", map[string]any{"action": "disable", "stationIds": []any{"st_a"}}},
		{"rotate", []string{"mcp-proxy", "rotate", "st_a"}, "POST", "/api/fleet/mcp-proxy/rotate", map[string]any{"stationIds": []any{"st_a"}}},
		{"rotate node", []string{"mcp-proxy", "rotate", "--node", "nod_1"}, "POST", "/api/fleet/mcp-proxy/rotate", map[string]any{"nodeId": "nod_1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != tc.method || r.URL.RequestURI() != tc.path {
					t.Errorf("route = %s %s; want %s %s", r.Method, r.URL.RequestURI(), tc.method, tc.path)
				}
				if tc.body != nil {
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Errorf("decode body: %v", err)
					}
					if !reflect.DeepEqual(body, tc.body) {
						t.Errorf("body = %v; want %v", body, tc.body)
					}
				}
				_, _ = w.Write([]byte(`{"results":[]}`))
			}))
			defer srv.Close()
			out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}, tc.args...)
			if code != 0 || !strings.Contains(out, `"results"`) {
				t.Fatalf("%s failed (%d): %s", tc.name, code, out)
			}
		})
	}
	for _, bad := range [][]string{
		{"mcp-proxy", "enable"},
		{"mcp-proxy", "enable", "--all-eligible", "st_a"},
		{"mcp-proxy", "enable", "--node", "nod_1", "st_a"},
		{"mcp-proxy", "disable"},
		{"mcp-proxy", "rotate"},
		{"mcp-proxy", "rotate", "--node", "nod_1", "st_a"},
		{"mcp-proxy", "frobnicate"},
	} {
		if _, code := run(t, bin, nil, bad...); code != 2 {
			t.Errorf("%v exited %d; want 2 (usage) with nothing sent", bad, code)
		}
	}
}
