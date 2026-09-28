package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// rolloutTimeout bounds `fleet nodes update`. The hub updates one node at a
// time and waits for each to answer, so the round trip grows with the fleet;
// the per-verb 75 seconds would cut a healthy rollout off mid-way and leave the
// operator guessing which nodes moved.
const rolloutTimeout = 15 * time.Minute

// fleet nodes — list the fleet, or roll a release across it.
//
// The rollout is the hub's own (POST /api/nodes/update-all, issue #295): one
// node at a time, in name order, skipping nodes whose binary comes from an
// image. This verb only asks for it. Before it existed the only callers were
// the Console button and a curl with the hub's root API_TOKEN, which is the
// credential this CLI exists to keep out of an operator's shell.
func fleetNodes(args []string) {
	if len(args) == 0 {
		fleetGet("/api/nodes", nil)
		return
	}
	if helpRequested(args) || args[0] != "update" {
		fmt.Println(`Usage: fleet nodes [update]

  fleet nodes                               the fleet's nodes, with versions
  fleet nodes update [--node NAME|ID …] [--force]

update asks the hub to roll the newest release to your nodes, one at a time,
and prints what happened to each. With --node it touches only those nodes
(repeatable; a name or an ID from ` + "`fleet nodes`" + `). --force re-applies the current
release to a node that already has it — the escape hatch for a corrupt binary.

Only the node-agent restarts; the harnesses it serves keep running. The exit
status is 1 if any node was asked and did not update.`)
		if !helpRequested(args) {
			os.Exit(2)
		}
		return
	}

	fs := flag.NewFlagSet("fleet nodes update", flag.ExitOnError)
	force := fs.Bool("force", false, "re-apply the current release")
	var named stringList
	fs.Var(&named, "node", "node name or ID (repeatable)")
	fs.Parse(args[1:])
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "unexpected argument:", fs.Arg(0))
		os.Exit(2)
	}

	payload := map[string]any{"force": *force}
	if len(named) > 0 {
		payload["only"] = resolveNodeIDs(named)
	}
	b, _ := json.Marshal(payload)
	response := fleetRequestBytes(http.MethodPost, "/api/nodes/update-all", bytes.NewReader(b), "application/json", rolloutTimeout)
	fmt.Println(string(bytes.TrimSpace(response)))

	var rollout struct {
		Summary struct {
			Failed int `json:"failed"`
		} `json:"summary"`
	}
	if err := json.Unmarshal(response, &rollout); err != nil {
		fmt.Fprintln(os.Stderr, "the hub's answer did not decode; check `fleet nodes` for versions")
		os.Exit(1)
	}
	if rollout.Summary.Failed > 0 {
		fmt.Fprintf(os.Stderr, "%d node(s) did not update; see the results above\n", rollout.Summary.Failed)
		os.Exit(1)
	}
}

// resolveNodeIDs maps each name or ID to a node ID, refusing the lot if any is
// unknown. The hub's `only` takes IDs and silently ignores one it does not
// recognise, so a typo would otherwise become a rollout of nothing reported as
// success.
func resolveNodeIDs(named []string) []string {
	var nodes []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(fleetRequestBytes(http.MethodGet, "/api/nodes", nil, "", 30*time.Second), &nodes); err != nil {
		fmt.Fprintln(os.Stderr, "could not read the node list:", err)
		os.Exit(1)
	}
	ids := make([]string, 0, len(named))
	var unknown []string
	for _, want := range named {
		found := ""
		for _, n := range nodes {
			if n.ID == want || n.Name == want {
				found = n.ID
				break
			}
		}
		if found == "" {
			unknown = append(unknown, want)
			continue
		}
		ids = append(ids, found)
	}
	if len(unknown) > 0 {
		fmt.Fprintf(os.Stderr, "no node named %s (see `fleet nodes`); nothing was updated\n", strings.Join(unknown, ", "))
		os.Exit(2)
	}
	return ids
}
