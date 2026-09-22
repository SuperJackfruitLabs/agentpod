package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
)

// fleet stations — the adoption surface the Console already had and this CLI
// did not. A station the node detects is not yet an agent: it becomes one when
// it is adopted, and only adopted stations carry the ID every skills verb
// needs. Without these verbs an operator could detect a station on the host,
// see it nowhere in the fleet, and have no way to find out why.
func fleetStations(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(`Usage: fleet stations <verb>

  fleet stations detected --node NODE_ID     what the node reports right now
  fleet stations list --node NODE_ID         adopted stations, with their IDs
  fleet stations adopt --node NODE_ID --key KEY [--key KEY …]
  fleet stations unadopt --station STATION_ID

A detected station is not an agent until it is adopted. Adopting re-detects on
the node first, so a key that has gone away is not adopted from a stale list.`)
		return
	}
	fs := flag.NewFlagSet("fleet stations", flag.ExitOnError)
	node := fs.String("node", "", "node ID")
	station := fs.String("station", "", "station ID")
	var keys stringList
	fs.Var(&keys, "key", "station key to adopt (repeatable)")
	fs.Parse(args[1:])
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
	default:
		fmt.Fprintf(os.Stderr, "unknown stations command: %q\n", args[0])
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
		return fmt.Errorf("station key must not be empty")
	}
	*s = append(*s, value)
	return nil
}
