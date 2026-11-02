package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcli"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/otelenv"
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
	if args[0] == "telemetry" {
		fleetNodesTelemetry(args[1:])
		return
	}
	if args[0] == "rm" {
		fleetNodesRemove(args[1:])
		return
	}
	if helpRequested(args) || args[0] != "update" {
		fmt.Println(fleetcli.NodesUsage)
		if !helpRequested(args) {
			os.Exit(2)
		}
		return
	}

	fs := flag.NewFlagSet("fleet nodes update", flag.ExitOnError)
	force := fs.Bool("force", false, "re-apply the current release")
	var named stringList
	fs.Var(&named, "node", "node name or ID (repeatable)")
	_ = fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
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

// fleetNodesTelemetry lists (no flags) or sets (--endpoint | --off) the
// OpenTelemetry endpoint on nodes, through the admin-only hub routes.
func fleetNodesTelemetry(args []string) {
	if helpRequested(args) {
		fmt.Println(fleetcli.NodesTelemetryUsage)
		return
	}
	fs := flag.NewFlagSet("fleet nodes telemetry", flag.ExitOnError)
	endpoint := fs.String("endpoint", "", "OTLP/HTTP endpoint URL (http or https)")
	off := fs.Bool("off", false, "disable telemetry export")
	var named stringList
	fs.Var(&named, "node", "node name or ID (repeatable)")
	_ = fs.Parse(args) // the FlagSet reports a bad flag itself
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
		Results []fleetcli.TelemetryRow `json:"results"`
	}
	if err := json.Unmarshal(response, &answer); err != nil {
		fmt.Fprintln(os.Stderr, "the hub's answer did not decode:", err)
		os.Exit(1)
	}
	bad := 0
	for _, r := range answer.Results {
		fmt.Printf("%-24s %-12s %s\n", r.Name, r.Status, r.Detail())
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
	req, err := http.NewRequestWithContext(context.Background(), method, hubBase()+"/api/nodes/telemetry", body)
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

// fleet nodes rm — DELETE /api/nodes/:id.
//
// A name is resolved to an id from the node list; anything the list does not
// know is sent as an id unchanged, so the hub's 404 is what an operator sees
// for a node that is not there or not theirs.
func fleetNodesRemove(args []string) {
	if helpRequested(args) {
		fmt.Println(fleetcli.NodesRmUsage)
		return
	}
	fs := flag.NewFlagSet("fleet nodes rm", flag.ExitOnError)
	force := fs.Bool("force", false, "disconnect and remove a node that is connected")
	fs.Usage = func() { fmt.Fprintln(fs.Output(), fleetcli.NodesRmUsage) }
	// The flag may come before or after the node: parse, take the node, parse
	// what follows it.
	_ = fs.Parse(args) // the FlagSet reports a bad flag itself
	var positional []string
	for fs.NArg() > 0 {
		positional = append(positional, fs.Arg(0))
		_ = fs.Parse(fs.Args()[1:]) // the FlagSet reports a bad flag itself
	}
	if len(positional) != 1 {
		fmt.Fprintln(os.Stderr, fleetcli.NodesRmUsage)
		os.Exit(2)
	}
	id := nodeIDFor(positional[0])

	path := "/api/nodes/" + url.PathEscape(id)
	if *force {
		path += "?force=1"
	}
	c := requireCredential()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodDelete, hubBase()+path, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "could not reach %s: %v\n", hubBase(), err)
		os.Exit(1)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode == http.StatusConflict {
		var refusal struct {
			Code  string `json:"code"`
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &refusal) == nil && refusal.Error != "" {
			fmt.Fprintln(os.Stderr, "not removed:", refusal.Error)
			if refusal.Code == "online" {
				fmt.Fprintf(os.Stderr, "\n  fleet nodes rm %s --force\n", positional[0])
			}
			os.Exit(1)
		}
	}
	if res.StatusCode >= 400 {
		fmt.Fprintf(os.Stderr, "hub returned %d: %s\n", res.StatusCode, bytes.TrimSpace(body))
		os.Exit(1)
	}
	fmt.Println(string(bytes.TrimSpace(body)))
}

// nodeIDFor maps a node name to its id, or returns the argument unchanged when
// no node is named that (it may be an id, or nothing the hub knows).
func nodeIDFor(nameOrID string) string {
	var nodes []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(fleetRequestBytes(http.MethodGet, "/api/nodes", nil, "", 30*time.Second), &nodes); err != nil {
		fmt.Fprintln(os.Stderr, "could not read the node list:", err)
		os.Exit(1)
	}
	for _, n := range nodes {
		if n.ID == nameOrID {
			return n.ID
		}
	}
	for _, n := range nodes {
		if n.Name == nameOrID {
			return n.ID
		}
	}
	return nameOrID
}
