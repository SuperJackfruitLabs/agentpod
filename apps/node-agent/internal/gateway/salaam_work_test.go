package gateway

import (
	"context"
	"encoding/json"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPrivateWorkGatewayUsesIndependentOwner(t *testing.T) {
	b := salaam.Binding{Version: 1, OrganizationID: "org_00000000000000000001", PrincipalID: "prn_00000000000000000002", NodeID: "node", StationID: "station", StationKey: salaam.StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: salaam.Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	payload := salaam.WorkPayload{Admission: salaam.WorkAdmission{Version: 1, RequestID: "11111111-1111-4111-8111-111111111111", Binding: b}, Input: json.RawMessage(`{}`), Plan: json.RawMessage(`{}`)}
	raw, _ := json.Marshal(payload)
	for _, different := range []bool{false, true} {
		calls := []string{}
		client := &salaam.Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: salaamMCPTransport(func(r *http.Request) (*http.Response, error) {
			calls = append(calls, r.URL.Path)
			var response any
			if strings.HasSuffix(r.URL.Path, "/status") {
				owner := b
				if different {
					owner.Run.Epoch++
				}
				response = salaam.Status{Binding: owner, AdmissionID: "admission", SessionID: "session", BindingDigest: strings.Repeat("a", 64)}
			} else if strings.HasSuffix(r.URL.Path, "/work-admit") {
				response = salaam.WorkReceipt{Version: 1, State: "admitted", SessionID: "session", TaskID: "task", RequestID: payload.Admission.RequestID, BindingDigest: strings.Repeat("a", 64), PlanRevision: 1}
			} else {
				t.Fatalf("unexpected path %s", r.URL.Path)
			}
			data, _ := json.Marshal(response)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(data))), Header: http.Header{}}, nil
		})}}
		h := NewSalaamHandler(nil, client)
		_, stream, err := h.Handle(context.Background(), "salaam.work-admit", raw, nil)
		if stream || (err != nil) != different {
			t.Fatalf("receipt %v, stream %v", err, stream)
		}
		if different && len(calls) != 1 {
			t.Fatalf("changed owner reached work admission: %v", calls)
		}
		if !different && len(calls) != 2 {
			t.Fatal(calls)
		}
		_, _, err = h.Handle(context.Background(), "salaam.work-admit", append(raw, []byte(` {}`)...), nil)
		if err == nil {
			t.Fatal("accepted trailing payload")
		}
	}
}
