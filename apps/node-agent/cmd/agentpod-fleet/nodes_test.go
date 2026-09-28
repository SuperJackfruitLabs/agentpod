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
