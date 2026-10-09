package main

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
)

// fleetBridgeRelatedWork switches a board's "Related prior work" section on or off: the earlier
// work Superlibrary finds for a claimed card, put into the card's prompt as reference material.
//
// On for every board until switched off. The next claim on the board reads the new value; no
// agent restarts.
func fleetBridgeRelatedWork(args []string) {
	if len(args) != 2 || args[0] == "" || (args[1] != "on" && args[1] != "off") {
		fmt.Fprintf(os.Stderr, "usage: fleet bridge related-work BOARD on|off\n\n%s\n", bridgeUsage)
		os.Exit(2)
	}
	fleetSkillJSON(http.MethodPut, "/api/admin/bridge/boards/"+url.PathEscape(args[0]), map[string]any{"relatedWork": args[1] == "on"})
}
