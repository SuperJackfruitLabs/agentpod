package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
)

const configUsage = `usage:
  fleet config settings                          every setting the fleet can declare
  fleet config show   [--station ID | --node ID] declared vs observed, with state
  fleet config set    SETTING_ID --value V [--station ID | --node ID]
  fleet config unset  SETTING_ID [--station ID | --node ID]
  fleet config drift                             every station whose value differs

` + "`set` records a DECLARATION; it does not write to a station. Writing is a\n" +
	"separate reviewed operation, and is not in this release."

// fleetConfig declares what a harness setting should be, and reports what each
// station actually has.
//
// `set` deliberately does not write to a station. The gap between declaring and
// applying is the design, not an omission: a harness rewrites its own config and
// persists operator decisions into it, so nothing here moves a file unasked.
func fleetConfig(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(configUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/fleet/config"
	switch args[0] {
	case "settings":
		fleetGet(base+"/settings", args)
	case "drift":
		fleetGet(base+"/drift", args)
	case "show":
		fs := flag.NewFlagSet("fleet config show", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		node := fs.String("node", "", "node ID")
		fs.Parse(args[1:])
		if *station != "" {
			fleetGet("/api/stations/"+url.PathEscape(*station)+"/config", args)
			return
		}
		q := base + "/declared"
		if *node != "" {
			q += "?node=" + url.QueryEscape(*node)
		}
		fleetGet(q, args)
	case "set":
		id := needArg(args, 1, "set", configUsage)
		fs := flag.NewFlagSet("fleet config set", flag.ExitOnError)
		value := fs.String("value", "", "the declared value")
		station := fs.String("station", "", "station ID")
		node := fs.String("node", "", "node ID")
		fs.Parse(args[2:])
		if *value == "" {
			fmt.Fprintf(os.Stderr, "set requires --value\n\n%s\n", configUsage)
			os.Exit(2)
		}
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "value": *value,
			"stationId": nullable(*station), "nodeId": nullable(*node),
		})
		fleetSkillRequest(http.MethodPut, base+"/declared", bytes.NewReader(body), "application/json")
	case "unset":
		id := needArg(args, 1, "unset", configUsage)
		fs := flag.NewFlagSet("fleet config unset", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		node := fs.String("node", "", "node ID")
		fs.Parse(args[2:])
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "stationId": nullable(*station), "nodeId": nullable(*node),
		})
		fleetSkillRequest(http.MethodDelete, base+"/declared", bytes.NewReader(body), "application/json")
	default:
		fmt.Fprintln(os.Stderr, configUsage)
		os.Exit(2)
	}
}

// nullable turns an unset flag into a JSON null, so "not this level" and "the
// empty string" cannot arrive looking alike.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
