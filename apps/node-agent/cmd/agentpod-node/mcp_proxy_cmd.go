package main

import (
	"fmt"
	"io"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/mcpproxy"
)

// mcpProxyEntry is `apn mcp-proxy`, against the node's own config and state file.
func mcpProxyEntry(args []string, out, errOut io.Writer) int {
	cfgPath := config.DefaultPath()
	return mcpProxyCmd(args, cfgPath, filepath.Join(filepath.Dir(cfgPath), mcpproxy.StateFileName), out, errOut)
}

// mcpProxyCmd shows which stations the node's loopback MCP proxy serves, and rotates their
// secrets. A rotation is written to the proxy's state file, which the running node re-reads at the
// next request: a session holding the old secret is refused from then on, with no restart.
// Secrets are never printed. Which stations are served is changed with `fleet mcp-proxy`, so the
// change is audited on the hub.
func mcpProxyCmd(args []string, cfgPath, statePath string, out, errOut io.Writer) int {
	if maybeShowHelp(out, "mcp-proxy", args) {
		return 0
	}
	usage := "usage: apn mcp-proxy <status|rotate [STATION_ID...]>"
	if len(args) == 0 {
		fmt.Fprintln(errOut, usage)
		return 2
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		fmt.Fprintln(errOut, "not enrolled; run `agentpod-node enroll` first:", err)
		return 1
	}
	var configured []string
	if cfg.MCPProxy != nil {
		configured = cfg.MCPProxy.Stations
	}
	store := mcpproxy.OpenStore(statePath)
	switch args[0] {
	case "status":
		if len(args) != 1 {
			fmt.Fprintln(errOut, usage)
			return 2
		}
		if len(configured) == 0 {
			fmt.Fprintln(out, "mcp proxy: serves no stations")
			return 0
		}
		fmt.Fprintf(out, "mcp proxy: serves %d station(s)\n", len(configured))
		for _, id := range configured {
			_, has, err := store.Secret(id)
			if err != nil {
				fmt.Fprintln(errOut, err)
				return 1
			}
			state := "secret persisted"
			if !has {
				state = "no secret yet (made at the next start)"
			}
			fmt.Fprintf(out, "  %s  %s\n", id, state)
		}
		return 0
	case "rotate":
		served := map[string]bool{}
		for _, id := range configured {
			served[id] = true
		}
		ids := args[1:]
		for _, id := range ids {
			if !served[id] {
				fmt.Fprintf(errOut, "the proxy does not serve %s; nothing rotated\n", id)
				return 1
			}
		}
		if len(ids) == 0 {
			ids = configured
		}
		if len(ids) == 0 {
			fmt.Fprintln(out, "mcp proxy: serves no stations; nothing to rotate")
			return 0
		}
		rotated, err := store.Rotate(ids)
		if err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		for _, id := range rotated {
			fmt.Fprintf(out, "rotated %s\n", id)
		}
		fmt.Fprintln(out, "sessions holding the old secret are refused from their next request; new sessions get the new one")
		return 0
	default:
		fmt.Fprintf(errOut, "unknown mcp-proxy action: %q\n", args[0])
		fmt.Fprintln(errOut, usage)
		return 2
	}
}
