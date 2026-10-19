package salaam

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestAuthorityRejectsForeignNodeBeforeControlAndNeverReturnsTokenToHub(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000001", PrincipalID: "prn_00000000000000000002", NodeID: "node_fixture", StationID: "station_fixture", StationKey: StationKey("/workspace"), OccupancyEpoch: 3, HubSessionID: "acps_fixture", Workspace: "/workspace", Run: Run{Source: "superpipeline", ID: "run_fixture", Epoch: 7}}
	calls := 0
	c := &Client{State: "/private", NodeID: b.NodeID, Workspace: b.Workspace, HTTP: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		calls++
		out := map[string]any{"admission_id": "admission", "session_id": "session", "binding": b, "authorized": true, "token": "local-secret"}
		data, _ := json.Marshal(out)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})}}
	foreign := b
	foreign.NodeID = "foreign"
	if _, err := c.Request(context.Background(), "admit", foreign, "request", 0, ""); err == nil || calls != 0 {
		t.Fatal("foreign node reached control")
	}
	public, err := c.Request(context.Background(), "admit", b, "request", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(public)
	if strings.Contains(string(encoded), "local-secret") || strings.Contains(string(encoded), "token") {
		t.Fatal("control secret leaked to hub")
	}
	env, err := c.ACPEnv(context.Background(), b)
	if err != nil || len(env) != 2 || env[1] != "SALAAM_AGENTPOD_TOKEN=local-secret" {
		t.Fatalf("missing private process admission: %v", err)
	}
}
func TestSharedAuthorityFixtureAndUnknownFields(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "contract", "src", "fixtures", "salaam-authority-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var b Binding
	if err = json.Unmarshal(data, &b); err != nil {
		t.Fatal(err)
	}
	if err := (&Client{NodeID: b.NodeID, Workspace: b.Workspace}).validate(b); err != nil {
		t.Fatalf("canonical shared fixture rejected: %v", err)
	}
	if b.OccupancyEpoch != 3 || b.Run.Epoch != 7 {
		t.Fatal("authority fields drifted")
	}
	data = []byte(strings.Replace(string(data), `"version": 1`, `"version": 1, "mayDispatch": ["*"]`, 1))
	if json.Unmarshal(data, &b) == nil {
		t.Fatal("unknown authority accepted")
	}
}

func TestRuntimeFailureCannotBlockStopOrInspection(t *testing.T) {
	calls := 0
	c := &Client{Runtime: &Runtime{Node: "unreviewed"}, HTTP: &http.Client{Transport: transport(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	for _, action := range []string{"status", "revoke"} {
		if err := c.call(context.Background(), action, map[string]any{}, new(any)); err != nil {
			t.Fatal(err)
		}
	}
	for _, action := range []string{"admit", "renew"} {
		if err := c.call(context.Background(), action, map[string]any{}, new(any)); err == nil {
			t.Fatal(fmt.Sprintf("%s bypassed reviewed runtime", action))
		}
	}
	if calls != 2 {
		t.Fatalf("stop/inspection were blocked or dispatch escaped: %d", calls)
	}
}
