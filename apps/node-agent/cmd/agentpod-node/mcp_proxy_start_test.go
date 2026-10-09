package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/mcpproxy"
)

// The node's own wiring: the proxy runs with no stations (so one can be enabled without a
// restart), and keeps its state in the node's config directory, so a second start — a node
// restart — hands a session the same URL and secret it had.
func TestTheNodesProxyPersistsAcrossStarts(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{Hub: "https://hub.example", NodeID: "n", NodeSecret: "s"}

	_, empty, stop := startMCPProxy(cfg, nil, dir)
	if empty == nil {
		t.Fatal("no proxy without stations; enabling one would need a restart")
	}
	stop()

	cfg.MCPProxy = &config.MCPProxy{Stations: []string{"station_a"}}
	_, p1, stop1 := startMCPProxy(cfg, nil, dir)
	before := p1.Servers("station_a")
	stop1()
	_, p2, stop2 := startMCPProxy(cfg, nil, dir)
	defer stop2()
	if len(before) == 0 || !reflect.DeepEqual(p2.Servers("station_a"), before) {
		t.Fatal("a restarted node handed out a different URL or secret")
	}
	fi, err := os.Stat(filepath.Join(dir, mcpproxy.StateFileName))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode %v", fi.Mode().Perm())
	}
}
