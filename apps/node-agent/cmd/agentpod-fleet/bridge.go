package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
)

const bridgeUsage = `usage:
  fleet bridge list
  fleet bridge add --key K --board B --station S --token T [--mcp-token M]
                   [--mode M] [--concurrency N] [--profile P] [--wait-ms N]
  fleet bridge set KEY [--board B] [--station S] [--mode M] [--enabled true|false]
                   [--token T] [--mcp-token M] [--concurrency N] [--profile P] [--wait-ms N]
  fleet bridge rm KEY`

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
		fmt.Println(bridgeUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/admin/bridge/agents"

	fs := flag.NewFlagSet("fleet bridge", flag.ExitOnError)
	key := fs.String("key", "", "roster key (add)")
	board := fs.String("board", "", "superpipeline board id")
	station := fs.String("station", "", "station id the work runs on")
	token := fs.String("token", "", "superpipeline agent token (claims)")
	mcpToken := fs.String("mcp-token", "", "run-scoped token the harness spends")
	mode := fs.String("mode", "", "permission mode")
	profile := fs.String("profile", "", "profile key")
	enabled := fs.String("enabled", "", "true or false")
	concurrency := fs.Int("concurrency", 0, "max cards at once")
	waitMs := fs.Int("wait-ms", 0, "permission wait, ms")

	switch args[0] {
	case "list":
		fleetGet(base, args)
	case "add":
		fs.Parse(args[1:])
		missing := []string{}
		for name, v := range map[string]string{"--key": *key, "--board": *board, "--station": *station, "--token": *token} {
			if v == "" {
				missing = append(missing, name)
			}
		}
		if len(missing) > 0 {
			// Named together rather than one at a time: four required flags discovered by four
			// failed invocations is four round trips to learn one sentence.
			fmt.Fprintf(os.Stderr, "add requires %v\n\n%s\n", missing, bridgeUsage)
			os.Exit(2)
		}
		body := map[string]any{"key": *key, "boardId": *board, "stationId": *station, "token": *token}
		addOptional(body, *mcpToken, *mode, *profile, *enabled, *concurrency, *waitMs)
		fleetSkillJSON(http.MethodPost, base, body)
	case "set":
		if len(args) < 2 || args[1] == "" {
			fmt.Fprintf(os.Stderr, "set requires a roster KEY\n\n%s\n", bridgeUsage)
			os.Exit(2)
		}
		fs.Parse(args[2:])
		body := map[string]any{}
		for field, v := range map[string]string{"boardId": *board, "stationId": *station, "token": *token} {
			if v != "" {
				body[field] = v
			}
		}
		addOptional(body, *mcpToken, *mode, *profile, *enabled, *concurrency, *waitMs)
		if len(body) == 0 {
			// A PATCH with nothing in it would answer 200 and change nothing, which reads as
			// success. Refusing here is the difference between "done" and "nothing happened".
			fmt.Fprintf(os.Stderr, "set needs at least one field to change\n\n%s\n", bridgeUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPatch, base+"/"+url.PathEscape(args[1]), body)
	case "rm":
		if len(args) < 2 || args[1] == "" {
			fmt.Fprintf(os.Stderr, "rm requires a roster KEY\n\n%s\n", bridgeUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodDelete, base+"/"+url.PathEscape(args[1]), nil)
	default:
		fmt.Fprintln(os.Stderr, bridgeUsage)
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
