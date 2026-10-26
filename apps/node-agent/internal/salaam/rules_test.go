package salaam

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// An agent's standing approval rules ride along on admit and renew only; Salaam validates them and
// pins them at admission. Without rules the field is absent, as before.
func TestApprovalRulesRideOnAdmitAndRenewOnly(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000001", PrincipalID: "prn_00000000000000000002", NodeID: "node_fixture", StationID: "station_fixture", StationKey: StationKey("/workspace"), OccupancyEpoch: 3, HubSessionID: "acps_one", Workspace: "/workspace", Run: Run{Source: "superpipeline", ID: "run_abc123", Epoch: 1}}
	var sent map[string]any
	c := &Client{State: "/private", NodeID: b.NodeID, Workspace: b.Workspace, HTTP: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		sent = nil
		_ = json.Unmarshal(body, &sent)
		data, _ := json.Marshal(map[string]any{"admission_id": "admission", "session_id": "session", "binding": b, "authorized": true})
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})}}
	rules := json.RawMessage(`[{"id":"6f1c2b9e-3a4d-4e5f-8a7b-1c2d3e4f5a6b","scope":"workspace-write","set_by":"prn_owner"}]`)
	for _, action := range []string{"admit", "renew"} {
		if _, err := c.RequestWithRules(context.Background(), action, b, action+":one", 1, rules); err != nil {
			t.Fatal(err)
		}
		got, _ := json.Marshal(sent["approval_rules"])
		if string(got) != string(rules) {
			t.Fatalf("%s did not carry the rules: %s", action, got)
		}
	}
	if _, err := c.RequestWithRules(context.Background(), "revoke", b, "revoke:one", 0, rules); err == nil {
		t.Fatal("rules were accepted on a revoke")
	}
	if _, err := c.Request(context.Background(), "renew", b, "renew:two", 2, ""); err != nil {
		t.Fatal(err)
	}
	if _, ok := sent["approval_rules"]; ok {
		t.Fatal("a renewal without rules sent the field")
	}
}
