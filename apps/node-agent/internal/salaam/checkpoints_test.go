package salaam

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Item 11: the run's checkpoints and one checkpoint's diff, read-only, for the run's own owner.
func TestWorkCheckpointsAreReadOnlyAndClosed(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	owner := Status{Binding: b, SessionID: "session"}
	var paths []string
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		w.Write([]byte(`{"version":1}`))
	}))
	defer server.Close()
	client := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	if _, err := client.WorkCheckpoints(context.Background(), b, "", owner); err != nil {
		t.Fatal(err)
	}
	if _, err := client.WorkCheckpoints(context.Background(), b, "ckp-1", owner); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 || paths[0] != "/v1/agentpod/work-checkpoints" || paths[1] != "/v1/agentpod/work-checkpoint-diff" {
		t.Fatal(paths)
	}
	if _, ok := bodies[0]["checkpoint_id"]; ok || bodies[1]["checkpoint_id"] != "ckp-1" {
		t.Fatal(bodies)
	}
	long := make([]byte, 129)
	for i := range long {
		long[i] = 'a'
	}
	if _, err := client.WorkCheckpoints(context.Background(), b, string(long), owner); err == nil {
		t.Fatal("accepted an unbounded checkpoint id")
	}
	changed := owner
	changed.Binding.Run.Epoch++
	if _, err := client.WorkCheckpoints(context.Background(), b, "", changed); err == nil {
		t.Fatal("accepted another owner")
	}
	if len(paths) != 2 {
		t.Fatal("a refused request reached the daemon")
	}
}
