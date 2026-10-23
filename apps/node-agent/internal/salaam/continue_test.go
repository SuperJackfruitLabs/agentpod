package salaam

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// A resume sends continue_from to Salaam and accepts only a receipt that says it continued that
// conversation. An older daemon ignores the field and starts empty; that must not pass for a resume.
func TestAdmitContinuingRequiresTheContinuationReceipt(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000001", PrincipalID: "prn_00000000000000000002", NodeID: "node_fixture", StationID: "station_fixture", StationKey: StationKey("/workspace"), OccupancyEpoch: 3, HubSessionID: "acps_second", Workspace: "/workspace", Run: Run{Source: "agentpod", ID: "acps_second", Epoch: 1}}
	var sent map[string]any
	continued := any("acps_first")
	c := &Client{State: "/private", NodeID: b.NodeID, Workspace: b.Workspace, HTTP: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &sent)
		out := map[string]any{"admission_id": "admission", "session_id": "session", "binding": b, "authorized": false, "continued_from": continued}
		data, _ := json.Marshal(out)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})}}
	status, err := c.AdmitContinuing(context.Background(), b, "admit:acps_second", "acps_first")
	if err != nil {
		t.Fatal(err)
	}
	if sent["continue_from"] != "acps_first" || status.ContinuedFrom == nil || *status.ContinuedFrom != "acps_first" {
		t.Fatalf("continuation not carried: sent %v, receipt %v", sent["continue_from"], status.ContinuedFrom)
	}
	continued = nil
	if _, err := c.AdmitContinuing(context.Background(), b, "admit:acps_second", "acps_first"); err == nil || !strings.Contains(err.Error(), "upgrade Salaam") {
		t.Fatalf("an older daemon's fresh session passed for a resume: %v", err)
	}
	continued = "acps_other"
	if _, err := c.AdmitContinuing(context.Background(), b, "admit:acps_second", "acps_first"); err == nil {
		t.Fatal("a receipt naming another conversation was accepted")
	}
}
