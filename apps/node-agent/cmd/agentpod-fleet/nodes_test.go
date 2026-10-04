package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const nodesFixture = `[
  {"id":"node_guild","name":"guild","agentVersion":"v0.1.76","status":"online"},
  {"id":"node_ashram","name":"ashram","agentVersion":"v0.1.76","status":"online"}
]`

// fakeRolloutHub answers GET /api/nodes with nodesFixture and records the
// update-all body; `summary` is what the rollout reports back.
type fakeRolloutHub struct {
	posts   int
	body    map[string]any
	summary string
}

func (f *fakeRolloutHub) server(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/nodes":
			_, _ = w.Write([]byte(nodesFixture))
		case r.Method == http.MethodPost && r.URL.Path == "/api/nodes/update-all":
			f.posts++
			f.body = map[string]any{}
			if err := json.NewDecoder(r.Body).Decode(&f.body); err != nil {
				t.Errorf("decode body: %v", err)
			}
			summary := f.summary
			if summary == "" {
				summary = `{"updated":2,"no-op":0,"skipped":0,"failed":0}`
			}
			_, _ = w.Write([]byte(`{"ok":true,"summary":` + summary + `,"results":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func rolloutEnv(url string) []string {
	return []string{"AGENTPOD_HUB=" + url, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}
}

func TestNodesStillListsTheFleet(t *testing.T) {
	bin := build(t)
	hub := &fakeRolloutHub{}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes")
	if code != 0 || !strings.Contains(out, "node_guild") {
		t.Fatalf("exit %d: %s", code, out)
	}
	if hub.posts != 0 {
		t.Fatal("listing nodes must not start a rollout")
	}
}

func TestNodesUpdateRollsTheWholeFleet(t *testing.T) {
	bin := build(t)
	hub := &fakeRolloutHub{}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "update")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if hub.posts != 1 {
		t.Fatalf("update-all posts = %d, want 1", hub.posts)
	}
	if hub.body["force"] != false {
		t.Fatalf("force = %v, want false", hub.body["force"])
	}
	if _, ok := hub.body["only"]; ok {
		t.Fatalf("a whole-fleet rollout must not narrow it: %v", hub.body)
	}
	if !strings.Contains(out, `"updated":2`) {
		t.Fatalf("output should carry the hub's per-node answer: %s", out)
	}
}

func TestNodesUpdateNamesNodesByNameOrID(t *testing.T) {
	bin := build(t)
	hub := &fakeRolloutHub{}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "update", "--node", "guild", "--node", "node_ashram", "--force")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	only, _ := hub.body["only"].([]any)
	if len(only) != 2 || only[0] != "node_guild" || only[1] != "node_ashram" {
		t.Fatalf("only = %v, want [node_guild node_ashram]", hub.body["only"])
	}
	if hub.body["force"] != true {
		t.Fatalf("force = %v, want true", hub.body["force"])
	}
}

func TestNodesUpdateRefusesAnUnknownNodeBeforeRollingAnything(t *testing.T) {
	bin := build(t)
	hub := &fakeRolloutHub{}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "update", "--node", "gild")
	if code != 2 {
		t.Fatalf("exit %d, want 2: %s", code, out)
	}
	if hub.posts != 0 {
		t.Fatal("a typo must not start a rollout")
	}
	if !strings.Contains(out, "gild") {
		t.Fatalf("the refusal should name what was not found: %s", out)
	}
}

func TestNodesUpdateFailsWhenANodeDidNotUpdate(t *testing.T) {
	bin := build(t)
	hub := &fakeRolloutHub{summary: `{"updated":1,"no-op":0,"skipped":0,"failed":1}`}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "update")
	if code != 1 {
		t.Fatalf("exit %d, want 1: a rollout with a failed node is not a success: %s", code, out)
	}
	if !strings.Contains(out, `"failed":1`) {
		t.Fatalf("the per-node answer must still be printed: %s", out)
	}
}

// fakeTelemetryHub serves the node list plus GET/POST /api/nodes/telemetry.
type fakeTelemetryHub struct {
	forbidden bool
	results   string // the "results" array the hub answers with
	gets      int
	posts     int
	body      map[string]any
}

func (f *fakeTelemetryHub) server(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/nodes":
			_, _ = w.Write([]byte(nodesFixture))
		case r.URL.Path == "/api/nodes/telemetry":
			if f.forbidden {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"ok":false,"error":"Admin access required"}`))
				return
			}
			if r.Method == http.MethodPost {
				f.posts++
				f.body = map[string]any{}
				_ = json.NewDecoder(r.Body).Decode(&f.body)
			} else {
				f.gets++
			}
			_, _ = w.Write([]byte(`{"ok":true,"summary":{},"results":` + f.results + `}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

const mixedResults = `[
 {"nodeId":"node_guild","name":"guild","status":"ok","endpoint":"http://otel:4318","enabled":true},
 {"nodeId":"node_ashram","name":"ashram","status":"offline"},
 {"nodeId":"node_old","name":"old","status":"unsupported","error":"node v0.1.60 predates telemetry config; run ` + "`fleet nodes update`" + `"}
]`

func TestNodesTelemetryListsEveryNode(t *testing.T) {
	bin := build(t)
	hub := &fakeTelemetryHub{results: `[
 {"nodeId":"node_guild","name":"guild","status":"ok","endpoint":"http://otel:4318","enabled":true},
 {"nodeId":"node_ashram","name":"ashram","status":"offline"}]`}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "telemetry")
	if code != 0 {
		t.Fatalf("exit %d, offline nodes must not fail a listing: %s", code, out)
	}
	if hub.gets != 1 || hub.posts != 0 {
		t.Fatalf("gets=%d posts=%d", hub.gets, hub.posts)
	}
	for _, want := range []string{"guild", "enabled", "http://otel:4318", "ashram", "offline"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q: %s", want, out)
		}
	}
}

func TestNodesTelemetryListShowsDisabledAndUnsupportedReason(t *testing.T) {
	bin := build(t)
	hub := &fakeTelemetryHub{results: mixedResults}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "telemetry")
	if code != 1 {
		t.Fatalf("exit %d, an unsupported node must fail: %s", code, out)
	}
	if !strings.Contains(out, "unsupported") || !strings.Contains(out, "fleet nodes update") {
		t.Fatalf("the reason must show: %s", out)
	}
}

func TestNodesTelemetryDisabledNode(t *testing.T) {
	bin := build(t)
	hub := &fakeTelemetryHub{results: `[{"nodeId":"node_guild","name":"guild","status":"ok","endpoint":"","enabled":false}]`}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "telemetry")
	if code != 0 || !strings.Contains(out, "disabled") {
		t.Fatalf("exit %d: %s", code, out)
	}
}

// "effective" is the endpoint the running process started with; when the file says
// something else (a restart has not happened yet) the listing must say so.
func TestNodesTelemetryShowsRunningEndpointWhenItDiffers(t *testing.T) {
	bin := build(t)
	hub := &fakeTelemetryHub{results: `[
 {"nodeId":"node_guild","name":"guild","status":"ok","endpoint":"http://new:4318","enabled":true,"effective":"http://old:4318"},
 {"nodeId":"node_ashram","name":"ashram","status":"ok","endpoint":"http://same:4318","enabled":true,"effective":"http://same:4318"}]`}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "telemetry")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if !strings.Contains(out, "running http://old:4318") {
		t.Fatalf("the stale running endpoint must show: %s", out)
	}
	if strings.Contains(out, "running http://same:4318") {
		t.Fatalf("a matching running endpoint is noise: %s", out)
	}
}

func TestNodesTelemetrySetEndpointFleetWide(t *testing.T) {
	bin := build(t)
	hub := &fakeTelemetryHub{results: `[
 {"nodeId":"node_guild","name":"guild","status":"changed","endpoint":"http://otel:4318","enabled":true,"restarting":true},
 {"nodeId":"node_ashram","name":"ashram","status":"unchanged","endpoint":"http://otel:4318","enabled":true}]`}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "telemetry", "--endpoint", "http://otel:4318")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if hub.body["endpoint"] != "http://otel:4318" {
		t.Fatalf("body = %v", hub.body)
	}
	if _, ok := hub.body["only"]; ok {
		t.Fatalf("fleet-wide must not narrow: %v", hub.body)
	}
	if _, ok := hub.body["off"]; ok {
		t.Fatalf("endpoint and off are exclusive: %v", hub.body)
	}
	if !strings.Contains(out, "changed") || !strings.Contains(out, "unchanged") || !strings.Contains(out, "restarting") {
		t.Fatalf("output: %s", out)
	}
}

func TestNodesTelemetryOffForNamedNodes(t *testing.T) {
	bin := build(t)
	hub := &fakeTelemetryHub{results: `[{"nodeId":"node_guild","name":"guild","status":"changed","enabled":false,"restarting":true}]`}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "telemetry", "--node", "guild", "--off")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if hub.body["off"] != true {
		t.Fatalf("body = %v", hub.body)
	}
	only, _ := hub.body["only"].([]any)
	if len(only) != 1 || only[0] != "node_guild" {
		t.Fatalf("only = %v", hub.body["only"])
	}
}

func TestNodesTelemetrySetFailsWhenAnyNodeIsNotApplied(t *testing.T) {
	for name, row := range map[string]string{
		"failed":      `{"nodeId":"node_guild","name":"guild","status":"failed","error":"boom"}`,
		"unsupported": `{"nodeId":"node_guild","name":"guild","status":"unsupported","error":"old"}`,
		"offline":     `{"nodeId":"node_guild","name":"guild","status":"offline"}`,
	} {
		t.Run(name, func(t *testing.T) {
			bin := build(t)
			hub := &fakeTelemetryHub{results: `[` + row + `]`}
			srv := hub.server(t)
			out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "telemetry", "--off")
			if code != 1 {
				t.Fatalf("exit %d, want 1: %s", code, out)
			}
			if !strings.Contains(out, name) {
				t.Fatalf("status should print: %s", out)
			}
		})
	}
}

func TestNodesTelemetryRefusesBadArgumentsBeforeTheHub(t *testing.T) {
	bin := build(t)
	for name, args := range map[string][]string{
		"both":        {"--endpoint", "http://x:4318", "--off"},
		"bad scheme":  {"--endpoint", "ftp://x"},
		"injection":   {"--endpoint", "http://x\nFOO=bar"},
		"node alone":  {"--node", "guild"},
		"stray arg":   {"--off", "extra"},
		"empty value": {"--endpoint", ""},
	} {
		t.Run(name, func(t *testing.T) {
			hub := &fakeTelemetryHub{results: `[]`}
			srv := hub.server(t)
			out, code := run(t, bin, rolloutEnv(srv.URL), append([]string{"nodes", "telemetry"}, args...)...)
			if code != 2 {
				t.Fatalf("exit %d, want 2: %s", code, out)
			}
			if hub.posts != 0 || hub.gets != 0 {
				t.Fatal("a bad request must not reach the hub")
			}
		})
	}
}

func TestNodesTelemetryUnknownNodeSendsNothing(t *testing.T) {
	bin := build(t)
	hub := &fakeTelemetryHub{results: `[]`}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "telemetry", "--node", "gild", "--off")
	if code != 2 || hub.posts != 0 || !strings.Contains(out, "gild") {
		t.Fatalf("exit %d posts %d: %s", code, hub.posts, out)
	}
}

func TestNodesTelemetryForbiddenSaysAdminRequired(t *testing.T) {
	bin := build(t)
	hub := &fakeTelemetryHub{forbidden: true}
	srv := hub.server(t)
	for _, args := range [][]string{{"nodes", "telemetry"}, {"nodes", "telemetry", "--off"}} {
		out, code := run(t, bin, rolloutEnv(srv.URL), args...)
		if code != 1 || !strings.Contains(out, "admin role required") {
			t.Fatalf("%v: exit %d: %s", args, code, out)
		}
	}
}

func TestNodesUsageMentionsTelemetry(t *testing.T) {
	bin := build(t)
	out, _ := run(t, bin, nil, "nodes", "--help")
	if !strings.Contains(out, "telemetry") {
		t.Fatalf("usage: %s", out)
	}
}

// The unit state of the node's systemd service rides along on each row. A restart
// only applies the configured endpoint when the unit is not drifted/errored, so the
// "(running X until restart)" hint is suppressed for those.
func TestTelemetryRowDetailUnitRendering(t *testing.T) {
	on := true
	str := func(s string) *string { return &s }
	guild := func(unit *string, detail string) telemetryRow {
		return telemetryRow{Enabled: &on, Endpoint: "http://foundry:4318", Effective: str(""), Unit: unit, UnitDetail: detail}
	}
	cases := []struct {
		name string
		row  telemetryRow
		want string
	}{
		{"old node, no unit", guild(nil, ""), "enabled http://foundry:4318 (running off until restart)"},
		{"current", guild(str("current"), ""), "enabled http://foundry:4318 (running off until restart) unit: current"},
		{"reconciled", guild(str("reconciled"), ""), "enabled http://foundry:4318 (running off until restart) unit: reconciled"},
		{"stale", guild(str("stale"), ""), "enabled http://foundry:4318 (running off until restart) unit: stale (re-rendered on next set or restart)"},
		{"drifted", guild(str("drifted"), ""), "enabled http://foundry:4318 unit: drifted (manual edits)"},
		{"error with detail", guild(str("error"), "daemon-reload failed"), "enabled http://foundry:4318 unit: error: daemon-reload failed"},
		{"error without detail", guild(str("error"), ""), "enabled http://foundry:4318 unit: error"},
		{"n/a", guild(str("n/a"), ""), "enabled http://foundry:4318 (running off until restart) unit: n/a"},
	}
	for _, c := range cases {
		if got := c.row.detail(); got != c.want {
			t.Errorf("%s: detail() = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestNodesTelemetryShowsUnitState(t *testing.T) {
	bin := build(t)
	hub := &fakeTelemetryHub{results: `[
 {"nodeId":"node_guild","name":"guild","status":"ok","endpoint":"http://foundry:4318","enabled":true,"effective":"","unit":"drifted"},
 {"nodeId":"node_ashram","name":"ashram","status":"ok","endpoint":"http://foundry:4318","enabled":true,"effective":"","unit":"current"}]`}
	srv := hub.server(t)
	out, code := run(t, bin, rolloutEnv(srv.URL), "nodes", "telemetry")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if !strings.Contains(out, "unit: drifted (manual edits)") || !strings.Contains(out, "unit: current") {
		t.Fatalf("unit states must render: %s", out)
	}
	if strings.Count(out, "until restart") != 1 {
		t.Fatalf("only the non-drifted node keeps the restart hint: %s", out)
	}
}
