package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

func TestDetectLoadsTheNodesRealConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"nodeId":"node_x","salaamBinary":"/opt/salaam","salaamStateDir":"/s","salaamWorkspace":"/w"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var seen config.Config
	detectStations(path, func(c config.Config) *descriptor.Registry { seen = c; return descriptor.NewRegistry() })
	if seen.SalaamBinary != "/opt/salaam" {
		t.Fatalf("detect built its registry without the node config: %+v", seen)
	}
	cfg, err := loadDetectConfig(path)
	if err != nil || cfg.SalaamBinary != "/opt/salaam" || cfg.SalaamWorkspace != "/w" || cfg.NodeID != "node_x" {
		t.Fatalf("detect ignored the node config: %+v %v", cfg, err)
	}
	if cfg, err := loadDetectConfig(filepath.Join(t.TempDir(), "absent.json")); err != nil || cfg.SalaamBinary != "" {
		t.Fatalf("unenrolled host must detect with defaults: %+v %v", cfg, err)
	}
}
