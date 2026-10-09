package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
)

const mcpProxyUsage = `usage:
  fleet mcp-proxy list [--node ID]                            every station: declared, served, state
  fleet mcp-proxy enable STATION_ID...                        serve these stations
  fleet mcp-proxy enable --all-eligible [--node ID]           serve every station whose harness can use it
  fleet mcp-proxy disable STATION_ID...                       stop serving these stations
  fleet mcp-proxy rotate STATION_ID... | --node ID            new secrets; sessions holding old ones are refused

The node's loopback MCP proxy gives a station's harness sessions the hub's and
Superlibrary's MCP tools, as the station's own agent. Only Hermes, Claude Code,
Codex and opencode stations can use it: OpenClaw's and Pi's ACP adapters take
no HTTP MCP servers in session/new, and enabling one is refused.

A change is written to the node's config and applied without a restart, and
leaves an audit row per station. A state of "drifted" means what was declared
here and what the node serves disagree — re-run enable or disable to settle it.
Secrets never leave the node.`

// fleetMCPProxy manages which stations each node's loopback MCP proxy serves.
func fleetMCPProxy(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(mcpProxyUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/fleet/mcp-proxy"
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("fleet mcp-proxy list", flag.ExitOnError)
		node := fs.String("node", "", "only this node")
		fs.Parse(args[1:])
		path := base
		if *node != "" {
			path += "?nodeId=" + url.QueryEscape(*node)
		}
		fleetGet(path, nil)
	case "enable":
		fs := flag.NewFlagSet("fleet mcp-proxy enable", flag.ExitOnError)
		all := fs.Bool("all-eligible", false, "every adopted station whose harness takes HTTP MCP servers (Hermes, Claude Code, Codex, opencode)")
		node := fs.String("node", "", "with --all-eligible: only this node's stations")
		fs.Parse(args[1:])
		body := map[string]any{"action": "enable"}
		switch {
		case *all && fs.NArg() > 0:
			fmt.Fprintln(os.Stderr, "enable takes STATION_ID... or --all-eligible, not both")
			os.Exit(2)
		case *all:
			body["allEligible"] = true
			if *node != "" {
				body["nodeId"] = *node
			}
		case fs.NArg() == 0:
			fmt.Fprintln(os.Stderr, "enable needs STATION_ID... or --all-eligible")
			os.Exit(2)
		case *node != "":
			fmt.Fprintln(os.Stderr, "--node narrows --all-eligible; name stations without it")
			os.Exit(2)
		default:
			body["stationIds"] = fs.Args()
		}
		fleetSkillJSON(http.MethodPost, base, body)
	case "disable":
		fs := flag.NewFlagSet("fleet mcp-proxy disable", flag.ExitOnError)
		fs.Parse(args[1:])
		if fs.NArg() == 0 {
			fmt.Fprintln(os.Stderr, "disable needs STATION_ID...")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base, map[string]any{"action": "disable", "stationIds": fs.Args()})
	case "rotate":
		fs := flag.NewFlagSet("fleet mcp-proxy rotate", flag.ExitOnError)
		node := fs.String("node", "", "every station this node's proxy serves")
		fs.Parse(args[1:])
		switch {
		case *node != "" && fs.NArg() > 0, *node == "" && fs.NArg() == 0:
			fmt.Fprintln(os.Stderr, "rotate takes STATION_ID... or --node ID")
			os.Exit(2)
		case *node != "":
			fleetSkillJSON(http.MethodPost, base+"/rotate", map[string]any{"nodeId": *node})
		default:
			fleetSkillJSON(http.MethodPost, base+"/rotate", map[string]any{"stationIds": fs.Args()})
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown mcp-proxy verb: %q\n%s\n", args[0], strings.SplitN(mcpProxyUsage, "\n\n", 2)[0])
		os.Exit(2)
	}
}
