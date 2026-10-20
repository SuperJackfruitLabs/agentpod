package salaam

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// Explicit acceptance input only: this test never discovers host credentials,
// changes a production manifest, or enables a station on its own.
func TestReviewedStrictHostIntegration(t *testing.T) {
	path := os.Getenv("SALAAM_M21_HOST_FIXTURE")
	if path == "" {
		t.Skip("requires isolated reviewed schema6 host fixture")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Node      string `json:"node"`
		CLI       string `json:"cli"`
		Manifest  string `json:"manifest"`
		State     string `json:"state"`
		Workspace string `json:"workspace"`
		NodeID    string `json:"node_id"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	runtime := &Runtime{Node: config.Node, CLI: config.CLI, Manifest: config.Manifest, State: config.State, Workspace: config.Workspace, NodeID: config.NodeID}
	client := &Client{State: config.State, Workspace: config.Workspace, NodeID: config.NodeID, Runtime: runtime}
	if _, err := client.WorkCapability(context.Background(), config.NodeID, config.Workspace, StationKey(config.Workspace)); err != nil {
		t.Fatal(err)
	}
	if _, err := client.WorkCapability(context.Background(), config.NodeID, config.Workspace+"-foreign", StationKey(config.Workspace)); err == nil {
		t.Fatal("foreign station admitted")
	}
	t.Log("actual reviewed host startup and private strict capability accepted; foreign station denied")
}
