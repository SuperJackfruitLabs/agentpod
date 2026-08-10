package main

import (
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// openclawBinary must reach the descriptor: on a node where openclaw is installed
// outside the service's PATH (e.g. a pnpm global install under
// ~/.local/share/pnpm, invisible to a systemd *user* service) it is the
// operator's escape hatch. A gateway URL is configured so resolving the ACP
// command skips the local gateway probe.
func TestBuildRegistry_ThreadsOpenClawBinary(t *testing.T) {
	reg := buildRegistry(config.Config{
		OpenClawBinary:     "/opt/custom/bin/openclaw",
		OpenClawGatewayURL: "wss://gateway.invalid:18789",
	})

	d, err := reg.For("openclaw")
	if err != nil {
		t.Fatalf("registry has no openclaw descriptor: %v", err)
	}
	c, ok := d.(descriptor.ACPCommander)
	if !ok {
		t.Fatalf("openclaw descriptor must implement ACPCommander, got %T", d)
	}

	argv, _, _, err := c.ACPCommand("openclaw")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if argv[0] != "/opt/custom/bin/openclaw" {
		t.Errorf("argv[0] = %q, want the configured openclawBinary", argv[0])
	}
}
