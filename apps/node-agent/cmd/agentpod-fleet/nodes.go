package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/otelenv"
)

// rolloutTimeout bounds `fleet nodes update`. The hub updates one node at a
// time and waits for each to answer, so the round trip grows with the fleet;
// the per-verb 75 seconds would cut a healthy rollout off mid-way and leave the
// operator guessing which nodes moved.
const rolloutTimeout = 15 * time.Minute

const nodesUsage = `Usage: fleet nodes [update|telemetry]

  fleet nodes                               the fleet's nodes, with versions
  fleet nodes update [--node NAME|ID …] [--force]
  fleet nodes telemetry                     each node's OpenTelemetry setting
  fleet nodes telemetry [--node NAME|ID …] --endpoint <url> | --off

update asks the hub to roll the newest release to your nodes, one at a time,
and prints what happened to each. With --node it touches only those nodes
(repeatable; a name or an ID from ` + "`fleet nodes`" + `). --force re-applies the current
release to a node that already has it — the escape hatch for a corrupt binary.

Only the node-agent restarts; the harnesses it serves keep running. The exit
status is 1 if any node was asked and did not update.

telemetry (admin role required) reads or sets the OTLP endpoint each node-agent
exports traces to, with no SSH. Without flags it lists the setting per node
(offline nodes are shown and do not fail the exit status). --endpoint takes an
http or https URL; --off disables export. A node restarts itself only if its
setting changed. A node too old to know the verb says "unsupported" until
` + "`fleet nodes update`" + `. The exit status is 1 if any node failed, was
unsupported, or (when setting) was offline and so did not apply the change.`

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
	if args[0] == "telemetry" {
		fleetNodesTelemetry(args[1:])
		return
	}
	if helpRequested(args) || args[0] != "update" {
		fmt.Println(nodesUsage)
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

// telemetryRow is one node's answer from GET/POST /api/nodes/telemetry.
type telemetryRow struct {
	Name       string `json:"name"`
	NodeID     string `json:"nodeId"`
	Status     string `json:"status"`
	Endpoint   string `json:"endpoint"`
	Enabled    *bool  `json:"enabled"`
	Restarting bool   `json:"restarting"`
	Error      string `json:"error"`
	// Effective is the endpoint the node process started with (status only; absent
	// on older nodes). It differs from Endpoint until the node restarts.
	Effective *string `json:"effective"`
	// Unit is the state of the node's systemd unit (current, stale, reconciled,
	// drifted, error, n/a); nil on older nodes. UnitDetail explains an error.
	Unit       *string `json:"unit"`
	UnitDetail string  `json:"unitDetail"`
}

// unitBlocksRestart reports whether the node's unit is in a state where a restart
// would not pick up the configured endpoint.
func (r telemetryRow) unitBlocksRestart() bool {
	return r.Unit != nil && (*r.Unit == "drifted" || *r.Unit == "error")
}

func (r telemetryRow) detail() string {
	var parts []string
	if r.Enabled != nil {
		if *r.Enabled {
			parts = append(parts, "enabled "+r.Endpoint)
		} else {
			parts = append(parts, "disabled")
		}
	}
	if r.Effective != nil && r.Enabled != nil {
		configured := ""
		if *r.Enabled {
			configured = r.Endpoint
		}
		if *r.Effective != configured {
			running := *r.Effective
			if running == "" {
				running = "off"
			}
			// A restart only applies the configured endpoint when the unit is
			// healthy; with a drifted or errored unit the hint would be a lie.
			if !r.unitBlocksRestart() {
				parts = append(parts, "(running "+running+" until restart)")
			}
		}
	}
	if r.Unit != nil {
		switch *r.Unit {
		case "drifted":
			parts = append(parts, "unit: drifted (manual edits)")
		case "error":
			if r.UnitDetail != "" {
				parts = append(parts, "unit: error: "+r.UnitDetail)
			} else {
				parts = append(parts, "unit: error")
			}
		case "stale":
			parts = append(parts, "unit: stale (re-rendered on next set or restart)")
		default:
			parts = append(parts, "unit: "+*r.Unit)
		}
	}
	if r.Restarting {
		parts = append(parts, "(restarting)")
	}
	if r.Error != "" {
		parts = append(parts, r.Error)
	}
	return strings.Join(parts, " ")
}

const nodesTelemetryUsage = `Usage: fleet nodes telemetry [--node NAME|ID …] [--endpoint <url> | --off]

With no flags, lists each node's telemetry setting. With --endpoint <url> (http
or https) or --off, sets it on every node, or only the --node ones. Admin role
required. Exit 1 if any node failed, was unsupported, or (when setting) offline.`

// fleetNodesTelemetry lists (no flags) or sets (--endpoint | --off) the
// OpenTelemetry endpoint on nodes, through the admin-only hub routes.
func fleetNodesTelemetry(args []string) {
	if helpRequested(args) {
		fmt.Println(nodesTelemetryUsage)
		return
	}
	fs := flag.NewFlagSet("fleet nodes telemetry", flag.ExitOnError)
	endpoint := fs.String("endpoint", "", "OTLP/HTTP endpoint URL (http or https)")
	off := fs.Bool("off", false, "disable telemetry export")
	var named stringList
	fs.Var(&named, "node", "node name or ID (repeatable)")
	fs.Parse(args)
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "unexpected argument:", fs.Arg(0))
		os.Exit(2)
	}
	endpointSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "endpoint" {
			endpointSet = true
		}
	})
	setting := endpointSet || *off
	switch {
	case endpointSet && *off:
		fmt.Fprintln(os.Stderr, "give --endpoint or --off, not both")
		os.Exit(2)
	case !setting && len(named) > 0:
		fmt.Fprintln(os.Stderr, "--node needs --endpoint <url> or --off; with neither, the whole fleet is listed")
		os.Exit(2)
	case endpointSet:
		if err := otelenv.ValidateEndpoint(*endpoint); err != nil {
			fmt.Fprintln(os.Stderr, "invalid --endpoint:", err)
			os.Exit(2)
		}
	}

	method, payload := http.MethodGet, io.Reader(nil)
	if setting {
		body := map[string]any{}
		if endpointSet {
			body["endpoint"] = *endpoint
		} else {
			body["off"] = true
		}
		if len(named) > 0 {
			body["only"] = resolveNodeIDs(named)
		}
		b, _ := json.Marshal(body)
		method, payload = http.MethodPost, bytes.NewReader(b)
	}
	response := telemetryRequest(method, payload)

	var answer struct {
		Results []telemetryRow `json:"results"`
	}
	if err := json.Unmarshal(response, &answer); err != nil {
		fmt.Fprintln(os.Stderr, "the hub's answer did not decode:", err)
		os.Exit(1)
	}
	bad := 0
	for _, r := range answer.Results {
		fmt.Printf("%-24s %-12s %s\n", r.Name, r.Status, r.detail())
		switch r.Status {
		case "failed", "unsupported":
			bad++
		case "offline":
			if setting {
				bad++
			}
		}
	}
	if bad > 0 {
		fmt.Fprintf(os.Stderr, "%d node(s) did not report or apply telemetry; see the results above\n", bad)
		os.Exit(1)
	}
}

// telemetryRequest is fleetRequestBytes with a plain 403 message: the hub
// refuses these routes to non-admins, and the generic "hub returned 403" does
// not say what to do about it.
func telemetryRequest(method string, body io.Reader) []byte {
	c := requireCredential()
	req, err := http.NewRequest(method, hubBase()+"/api/nodes/telemetry", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := (&http.Client{Timeout: rolloutTimeout}).Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "could not reach %s: %v\n", hubBase(), err)
		os.Exit(1)
	}
	defer res.Body.Close()
	response, _ := io.ReadAll(res.Body)
	if res.StatusCode == http.StatusForbidden {
		fmt.Fprintln(os.Stderr, "admin role required: the hub refused this account (403); node telemetry is admin-only")
		os.Exit(1)
	}
	if res.StatusCode >= 400 {
		fmt.Fprintf(os.Stderr, "hub returned %d: %s\n", res.StatusCode, bytes.TrimSpace(response))
		os.Exit(1)
	}
	return response
}
