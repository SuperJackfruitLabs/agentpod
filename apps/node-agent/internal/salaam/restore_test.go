package salaam

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Item 11b: restoring a checkpoint is one exact, operator-approved request for the run's owner.
func TestWorkRestoreIsExactAndClosed(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	owner := Status{Binding: b, SessionID: "session"}
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agentpod/work-restore" {
			t.Fatal(r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		w.Write([]byte(`{"version":1}`))
	}))
	defer server.Close()
	client := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	digest := strings.Repeat("a", 64)
	if _, err := client.WorkRestore(context.Background(), b, "restore:1", "ckp-1", digest, "prn_admin", owner); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 1 || bodies[0]["checkpoint_id"] != "ckp-1" || bodies[0]["restore_digest"] != digest || bodies[0]["approved_by"] != "prn_admin" || bodies[0]["request_id"] != "restore:1" {
		t.Fatal(bodies)
	}
	for name, call := range map[string]func() error{
		"no checkpoint": func() error {
			_, e := client.WorkRestore(context.Background(), b, "r", "", digest, "p", owner)
			return e
		},
		"bad digest": func() error {
			_, e := client.WorkRestore(context.Background(), b, "r", "c", "short", "p", owner)
			return e
		},
		"no approver": func() error {
			_, e := client.WorkRestore(context.Background(), b, "r", "c", digest, "", owner)
			return e
		},
		"no request": func() error {
			_, e := client.WorkRestore(context.Background(), b, "", "c", digest, "p", owner)
			return e
		},
		"another owner": func() error {
			o := owner
			o.Binding.Run.Epoch++
			_, e := client.WorkRestore(context.Background(), b, "r", "c", digest, "p", o)
			return e
		},
	} {
		if call() == nil {
			t.Fatal("accepted", name)
		}
	}
	if len(bodies) != 1 {
		t.Fatal("a refused restore reached the daemon")
	}
}
