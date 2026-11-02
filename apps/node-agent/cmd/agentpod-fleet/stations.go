package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcli"
)

// fleet stations — the adoption surface the Console already had and this CLI
// did not. A station the node detects is not yet an agent: it becomes one when
// it is adopted, and only adopted stations carry the ID every skills verb
// needs. Without these verbs an operator could detect a station on the host,
// see it nowhere in the fleet, and have no way to find out why.
func fleetStations(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(fleetcli.StationsUsage)
		return
	}
	if args[0] == "forge-api" {
		// Its own flag set: the forge-api verbs read flags no other stations verb has.
		fleetForgeAPI(args[1:])
		return
	}
	fs := flag.NewFlagSet("fleet stations", flag.ExitOnError)
	node := fs.String("node", "", "node ID")
	station := fs.String("station", "", "station ID")
	var keys stringList
	fs.Var(&keys, "key", "station key to adopt (repeatable)")
	_ = fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "unexpected argument")
		os.Exit(2)
	}
	switch args[0] {
	case "detected":
		requireNode(*node)
		fleetGet("/api/nodes/"+url.PathEscape(*node)+"/detected", nil)
	case "list":
		requireNode(*node)
		fleetGet("/api/nodes/"+url.PathEscape(*node)+"/stations", nil)
	case "adopt":
		requireNode(*node)
		if len(keys) == 0 {
			fmt.Fprintln(os.Stderr, "adopt requires at least one --key KEY")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, "/api/nodes/"+url.PathEscape(*node)+"/stations/adopt",
			map[string]any{"keys": []string(keys)})
	case "unadopt":
		if *station == "" {
			fmt.Fprintln(os.Stderr, "unadopt requires --station STATION_ID")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodDelete, "/api/stations/"+url.PathEscape(*station), nil)
	case "git-identity":
		requireStation(*station, "git-identity")
		fleetGet("/api/stations/"+url.PathEscape(*station)+"/git-identity", nil)
	case "grant-push":
		requireStation(*station, "grant-push")
		// No body: the account is derived from the station's occupying agent and the key is the
		// node's to generate. There is nothing for an operator to supply, and nothing they could
		// supply without being able to aim a key at somebody else's agent.
		fleetSkillJSON(http.MethodPost, "/api/stations/"+url.PathEscape(*station)+"/git-identity", nil)
	case "revoke-push":
		requireStation(*station, "revoke-push")
		fleetSkillJSON(http.MethodDelete, "/api/stations/"+url.PathEscape(*station)+"/git-identity", nil)
	default:
		fmt.Fprintf(os.Stderr, "unknown stations command: %q\n", args[0])
		os.Exit(2)
	}
}

func requireStation(station, verb string) {
	if station == "" {
		fmt.Fprintf(os.Stderr, "%s requires --station STATION_ID (see `fleet stations list`)\n", verb)
		os.Exit(2)
	}
}

func requireNode(node string) {
	if node == "" {
		fmt.Fprintln(os.Stderr, "this command requires --node NODE_ID (see `fleet nodes`)")
		os.Exit(2)
	}
}

// stringList collects a repeatable flag, so adopting several stations is one
// reviewed call rather than several.
type stringList []string

func (s *stringList) String() string { return fmt.Sprint([]string(*s)) }

func (s *stringList) Set(value string) error {
	if value == "" {
		return fmt.Errorf("value must not be empty")
	}
	*s = append(*s, value)
	return nil
}
