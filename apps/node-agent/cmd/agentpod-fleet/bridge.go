package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcli"
)

// fleetBridge manages the superpipeline roster: which agent claims work from which
// board, onto which station.
//
// This is the gate on an agent doing anything at all. An agent can be staffed, online
// and capable, and still never claim a card, because nothing in this table points it at
// a board — a distinction that is invisible from `fleet agents`, which reports stations
// rather than roster rows.
//
// `set` exists because the Console cannot do it: its Bridge page sets a board when it
// CREATES a row and only displays it afterwards, so repointing an agent there means
// removing the row and re-entering both credentials. That is a bad trade for a one-field
// change, and it is why this verb takes each field separately rather than a whole row.
//
// No verb here prints a credential. The hub's list surface does not return one, and a
// token reaches the hub only as an argument you supplied.
func fleetBridge(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(fleetcli.BridgeUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/admin/bridge/agents"

	fs := flag.NewFlagSet("fleet bridge", flag.ExitOnError)
	key := fs.String("key", "", "roster key (add)")
	board := fs.String("board", "", "SuperPipeline board id")
	station := fs.String("station", "", "station id the work runs on")
	token := fs.String("token", "", "SuperPipeline agent token (claims)")
	mcpToken := fs.String("mcp-token", "", "run-scoped token the harness spends")
	mode := fs.String("mode", "", "permission mode")
	profile := fs.String("profile", "", "profile key")
	enabled := fs.String("enabled", "", "true or false")
	concurrency := fs.Int("concurrency", 0, "max cards at once")
	waitMs := fs.Int("wait-ms", 0, "permission wait, ms")
	credentialSource := fs.String("credential-source", "", "station-plane, or none to return to a token (set)")
	principal := fs.String("principal", "", "the station occupant's prn_ id (station-plane)")
	organization := fs.String("organization", "", "the workspace's org_ id (station-plane)")
	audience := fs.String("audience", "", "this deployment's SuperPipeline origin (station-plane)")

	switch args[0] {
	case "list":
		fleetGet(base, args)
	case "add":
		_ = fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
		missing := []string{}
		for name, v := range map[string]string{"--key": *key, "--board": *board, "--station": *station, "--token": *token} {
			if v == "" {
				missing = append(missing, name)
			}
		}
		if len(missing) > 0 {
			// Named together rather than one at a time: four required flags discovered by four
			// failed invocations is four round trips to learn one sentence.
			fmt.Fprintf(os.Stderr, "add requires %v\n\n%s\n", missing, fleetcli.BridgeUsage)
			os.Exit(2)
		}
		body := map[string]any{"key": *key, "boardId": *board, "stationId": *station, "token": *token}
		addOptional(body, *mcpToken, *mode, *profile, *enabled, *concurrency, *waitMs)
		fleetSkillJSON(http.MethodPost, base, body)
	case "set":
		if len(args) < 2 || args[1] == "" {
			fmt.Fprintf(os.Stderr, "set requires a roster KEY\n\n%s\n", fleetcli.BridgeUsage)
			os.Exit(2)
		}
		_ = fs.Parse(args[2:]) // the FlagSet reports a bad flag itself
		body := map[string]any{}
		for field, v := range map[string]string{"boardId": *board, "stationId": *station, "token": *token} {
			if v != "" {
				body[field] = v
			}
		}
		addOptional(body, *mcpToken, *mode, *profile, *enabled, *concurrency, *waitMs)
		addCredentialSource(body, *credentialSource, *principal, *organization, *audience)
		if len(body) == 0 {
			// A PATCH with nothing in it would answer 200 and change nothing, which reads as
			// success. Refusing here is the difference between "done" and "nothing happened".
			fmt.Fprintf(os.Stderr, "set needs at least one field to change\n\n%s\n", fleetcli.BridgeUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPatch, base+"/"+url.PathEscape(args[1]), body)
	case "rm":
		if len(args) < 2 || args[1] == "" {
			fmt.Fprintf(os.Stderr, "rm requires a roster KEY\n\n%s\n", fleetcli.BridgeUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodDelete, base+"/"+url.PathEscape(args[1]), nil)
	case "related-work":
		fleetBridgeRelatedWork(args[1:])
	default:
		fmt.Fprintln(os.Stderr, fleetcli.BridgeUsage)
		os.Exit(2)
	}
}

// addOptional copies the flags that are shared by add and set, and only those the caller
// actually supplied.
//
// `--mcp-token ""` is NOT reachable here, deliberately: the hub treats a null mcpToken as
// "this agent loses its board tools but keeps its row", and an empty string arriving by
// accident from an unset flag would do that silently.
func addOptional(body map[string]any, mcpToken, mode, profile, enabled string, concurrency, waitMs int) {
	if mcpToken != "" {
		body["mcpToken"] = mcpToken
	}
	if mode != "" {
		body["mode"] = mode
	}
	if profile != "" {
		body["profileKey"] = profile
	}
	switch enabled {
	case "true":
		body["enabled"] = true
	case "false":
		body["enabled"] = false
	case "":
	default:
		fmt.Fprintf(os.Stderr, "--enabled takes true or false, got %q\n", enabled)
		os.Exit(2)
	}
	if concurrency > 0 {
		body["maxConcurrency"] = concurrency
	}
	if waitMs > 0 {
		body["permissionWaitMs"] = waitMs
	}
}

// addCredentialSource turns the station-plane flags into the hub's `credentialSource` field.
//
// A source is the agent's plane identity, not a secret: the hub exchanges it for a short-lived
// grant on every board request and stores no token. Setting one on a token row upgrades it in
// place, and the hub drops the stored tokens. `none` goes back to a token, which the hub refuses
// without a new `--token`.
//
// The three identity flags are all required together, and refused without
// `--credential-source station-plane`, so a half-typed source never reaches the hub as a
// different one. The hub still decides: the principal must occupy the row's Salaam station, the
// organization must be the workspace's, and the audience must be the hub's own SuperPipeline.
func addCredentialSource(body map[string]any, kind, principal, organization, audience string) {
	identity := principal != "" || organization != "" || audience != ""
	switch kind {
	case "":
		if identity {
			fmt.Fprintf(os.Stderr, "--principal, --organization and --audience need --credential-source station-plane\n\n%s\n", fleetcli.BridgeUsage)
			os.Exit(2)
		}
	case "none":
		if identity {
			fmt.Fprintln(os.Stderr, "--credential-source none takes no --principal, --organization or --audience")
			os.Exit(2)
		}
		if _, ok := body["token"]; !ok {
			fmt.Fprintln(os.Stderr, "--credential-source none needs a new --token: the row would have no credential")
			os.Exit(2)
		}
		body["credentialSource"] = nil
	case "station-plane":
		missing := []string{}
		for _, f := range []struct{ name, v string }{{"--principal", principal}, {"--organization", organization}, {"--audience", audience}} {
			if f.v == "" {
				missing = append(missing, f.name)
			}
		}
		if len(missing) > 0 {
			fmt.Fprintf(os.Stderr, "--credential-source station-plane requires %v\n\n%s\n", missing, fleetcli.BridgeUsage)
			os.Exit(2)
		}
		body["credentialSource"] = map[string]any{
			"version": 1, "kind": "station-plane",
			"principalId": principal, "organizationId": organization, "audience": audience,
		}
	default:
		fmt.Fprintf(os.Stderr, "--credential-source takes station-plane or none, got %q\n", kind)
		os.Exit(2)
	}
}
