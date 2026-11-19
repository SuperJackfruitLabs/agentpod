package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcli"
)

// fleetBridgeCheckpointSettle ends one unresolved checkpoint attempt as retired, with the
// operator's evidence: what they checked, and why nothing the attempt started is still running.
//
// The hub retires a superseded attempt on its own only when the node proves nothing is
// outstanding. Every other unresolved attempt waits for this. Settling deletes nothing: the row
// and its evidence stay, and the node is then told the attempt is no longer current, so it
// retires its own record too.
func fleetBridgeCheckpointSettle(args []string) {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		fmt.Fprintf(os.Stderr, "checkpoint-settle requires an ATTEMPT id\n\n%s\n", fleetcli.BridgeUsage)
		os.Exit(2)
	}
	attempt := args[0]
	fs := flag.NewFlagSet("fleet bridge checkpoint-settle", flag.ExitOnError)
	evidence := fs.String("evidence", "", "what you checked, and why nothing it started is still outstanding")
	_ = fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
	if len(strings.TrimSpace(*evidence)) < 20 {
		fmt.Fprintf(os.Stderr, "checkpoint-settle requires --evidence of at least 20 characters\n\n%s\n", fleetcli.BridgeUsage)
		os.Exit(2)
	}
	fleetSkillJSON(http.MethodPost, "/api/admin/checkpoint/attempts/"+url.PathEscape(attempt)+"/settle",
		map[string]any{"confirm": attempt, "evidence": *evidence})
}
