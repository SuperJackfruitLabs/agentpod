package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeRemoveHub answers GET /api/nodes with nodesFixture and DELETE
// /api/nodes/:id with `status`/`body`, recording what was deleted.
type fakeRemoveHub struct {
	deleted []string // path + "?" + raw query
	status  int
	body    string
}

func (f *fakeRemoveHub) server(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/nodes":
			_, _ = w.Write([]byte(nodesFixture))
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/nodes/"):
			f.deleted = append(f.deleted, r.URL.Path+"?"+r.URL.RawQuery)
			status := f.status
			if status == 0 {
				status = http.StatusOK
			}
			w.WriteHeader(status)
			body := f.body
			if body == "" {
				body = `{"ok":true,"node":{"id":"node_guild","name":"guild"},"stationsRemoved":[],"disconnected":false}`
			}
			_, _ = w.Write([]byte(body))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestNodesRmResolvesANameAndDeletesThatNode(t *testing.T) {
	bin := build(t)
	hub := &fakeRemoveHub{}
	out, code := run(t, bin, rolloutEnv(hub.server(t).URL), "nodes", "rm", "guild")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if len(hub.deleted) != 1 || hub.deleted[0] != "/api/nodes/node_guild?" {
		t.Fatalf("deleted = %v, want one DELETE of node_guild without force", hub.deleted)
	}
	if !strings.Contains(out, `"stationsRemoved"`) {
		t.Fatalf("the hub's answer was not printed: %s", out)
	}
}

func TestNodesRmForceAsksTheHubToDisconnect(t *testing.T) {
	bin := build(t)
	for _, args := range [][]string{
		{"nodes", "rm", "--force", "node_ashram"},
		{"nodes", "rm", "node_ashram", "--force"},
	} {
		hub := &fakeRemoveHub{}
		out, code := run(t, bin, rolloutEnv(hub.server(t).URL), args...)
		if code != 0 {
			t.Fatalf("%v: exit %d: %s", args, code, out)
		}
		if len(hub.deleted) != 1 || hub.deleted[0] != "/api/nodes/node_ashram?force=1" {
			t.Fatalf("%v: deleted = %v, want node_ashram with force=1", args, hub.deleted)
		}
	}
}

// An id the list does not know is still sent: the hub is what decides, and its
// 404 is the honest answer for a node that is not there or not yours.
func TestNodesRmUnknownNodeIsTheHubs404(t *testing.T) {
	bin := build(t)
	hub := &fakeRemoveHub{status: http.StatusNotFound, body: `{"ok":false,"error":"Not Found"}`}
	out, code := run(t, bin, rolloutEnv(hub.server(t).URL), "nodes", "rm", "node_nope")
	if code != 1 {
		t.Fatalf("exit %d, want 1: %s", code, out)
	}
	if len(hub.deleted) != 1 || !strings.Contains(out, "404") {
		t.Fatalf("deleted = %v, out = %s", hub.deleted, out)
	}
}

func TestNodesRmOnlineRefusalSaysToUseForce(t *testing.T) {
	bin := build(t)
	hub := &fakeRemoveHub{
		status: http.StatusConflict,
		body:   `{"ok":false,"code":"online","error":"This node is connected."}`,
	}
	out, code := run(t, bin, rolloutEnv(hub.server(t).URL), "nodes", "rm", "guild")
	if code != 1 {
		t.Fatalf("exit %d, want 1: %s", code, out)
	}
	if !strings.Contains(out, "This node is connected.") || !strings.Contains(out, "--force") {
		t.Fatalf("want the hub's reason and a --force hint: %s", out)
	}
}

func TestNodesRmProvisionedRefusalPassesTheHubsInstruction(t *testing.T) {
	bin := build(t)
	hub := &fakeRemoveHub{
		status: http.StatusConflict,
		body:   `{"ok":false,"code":"provisioned","runtimeId":"rt_1","error":"Remove the runtime instead: fleet runtimes rm rt_1"}`,
	}
	out, code := run(t, bin, rolloutEnv(hub.server(t).URL), "nodes", "rm", "--force", "guild")
	if code != 1 {
		t.Fatalf("exit %d, want 1: %s", code, out)
	}
	if !strings.Contains(out, "fleet runtimes rm rt_1") {
		t.Fatalf("want the hub's instruction: %s", out)
	}
}

func TestNodesRmNeedsExactlyOneNode(t *testing.T) {
	bin := build(t)
	hub := &fakeRemoveHub{}
	for _, args := range [][]string{{"nodes", "rm"}, {"nodes", "rm", "guild", "ashram"}} {
		out, code := run(t, bin, rolloutEnv(hub.server(t).URL), args...)
		if code != 2 {
			t.Fatalf("%v: exit %d, want 2: %s", args, code, out)
		}
	}
	if len(hub.deleted) != 0 {
		t.Fatalf("nothing should have been deleted: %v", hub.deleted)
	}
}
