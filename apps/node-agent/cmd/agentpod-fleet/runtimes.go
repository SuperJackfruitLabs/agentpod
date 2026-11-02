package main

import (
	"bytes"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcli"
)

// fleetRuntimes drives the substrate a node can run on.
//
// Worth knowing before using `stop`: the hub treats a runtime's state as EVIDENCE, not as
// a request's outcome. `stop` writes `stopping`, and only a provider reporting the
// container actually down writes `stopped` — because the absence of a node is not proof
// of a stop, and a container that is still up is still billing. So a `stop` that returns
// cleanly means "asked", and the state you read afterwards is the answer.
//
// `create` takes a file for the same reason `grants set` does: a provision request is a
// document the hub validates, and modelling its shape in flags here would mean disagreeing
// with the hub the first time it changes.
func fleetRuntimes(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(fleetcli.RuntimesUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/runtimes"
	switch args[0] {
	case "list":
		fleetGet(base, args)
	case "providers":
		fleetGet(base+"/providers", args)
	case "create":
		fs := flag.NewFlagSet("fleet runtimes create", flag.ExitOnError)
		file := fs.String("file", "", "provision request, or - for stdin")
		_ = fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
		if *file == "" {
			fmt.Fprintf(os.Stderr, "create requires --file PATH or --file -\n\n%s\n", fleetcli.RuntimesUsage)
			os.Exit(2)
		}
		fleetSkillRequest(http.MethodPost, base, bytes.NewReader(readDocument(*file)), "application/json")
	case "start", "stop":
		id := needArg(args, 1, args[0], fleetcli.RuntimesUsage)
		fleetSkillJSON(http.MethodPost, base+"/"+url.PathEscape(id)+"/"+args[0], map[string]any{})
	case "rm":
		id := needArg(args, 1, "rm", fleetcli.RuntimesUsage)
		fleetSkillJSON(http.MethodDelete, base+"/"+url.PathEscape(id), nil)
	default:
		fmt.Fprintln(os.Stderr, fleetcli.RuntimesUsage)
		os.Exit(2)
	}
}
