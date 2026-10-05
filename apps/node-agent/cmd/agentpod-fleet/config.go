package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"
)

const configUsage = `usage:
  fleet config settings                          every setting the fleet can declare
  fleet config show   [--node ID]                the declarations themselves, as stored
  fleet config show   --station ID               one station: declared vs observed, with state
  fleet config set    SETTING_ID --value V [--station ID | --node ID]
  fleet config unset  SETTING_ID [--station ID | --node ID]
  fleet config drift                             every station whose value differs
  fleet config plan    --station ID                 the edit that would be made, and its digest
  fleet config inspect --station ID --operation ID  a plan already made, as it was reviewed
  fleet config apply   --station ID --operation ID --plan-digest SHA256

` + "`set` records a DECLARATION; it does not write to a station. `apply` is the\n" +
	"verb that writes, and it refuses to run without --plan-digest: that digest\n" +
	"must be the one `plan` printed for this operation, so a human reviewed the\n" +
	"exact edit being written rather than whatever the current plan happens to\n" +
	"be by the time apply runs.\n\n" +
	"Only `show --station` and `drift` compare anything. Without --station, `show`\n" +
	"returns the declaration rows and contacts no station: no observed value, no\n" +
	"state. A fleet- or node-level declaration is one row that may apply to many\n" +
	"stations, so comparing it means naming which station you mean.\n\n" +
	"--station is accepted for any setting. A setting whose registered scope is\n" +
	"not `profile` is NOT refused here; it is stored, and reported `out-of-scope`\n" +
	"when the declaration is read back."

// fleetConfig declares what a harness setting should be, and reports what each
// station actually has.
//
// `set` deliberately does not write to a station. The gap between declaring and
// applying is the design, not an omission: a harness rewrites its own config and
// persists operator decisions into it, so nothing here moves a file unasked.
// `plan`, `inspect` and `apply` are the reviewed trio that eventually does write:
// `plan` asks the hub to derive the edit and its digest, `inspect` reads a plan
// already made exactly as it was reviewed, and `apply` writes — but only the
// plan named by the digest a human already saw, never whatever `plan` would
// derive if asked again right now.
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
	case "plan":
		fs := flag.NewFlagSet("fleet config plan", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		fs.Parse(args[1:])
		if *station == "" || fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "plan requires --station ID\n\n%s\n", configUsage)
			os.Exit(2)
		}
		fleetConfigPlan(*station)
	case "inspect":
		fs := flag.NewFlagSet("fleet config inspect", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		operation := fs.String("operation", "", "operation ID")
		fs.Parse(args[1:])
		if *station == "" || *operation == "" || fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "inspect requires --station ID --operation ID\n\n%s\n", configUsage)
			os.Exit(2)
		}
		fleetGet("/api/stations/"+url.PathEscape(*station)+"/config/operations/"+url.PathEscape(*operation), nil)
	case "apply":
		fs := flag.NewFlagSet("fleet config apply", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		operation := fs.String("operation", "", "operation ID")
		planDigest := fs.String("plan-digest", "", "reviewed plan digest")
		fs.Parse(args[1:])
		if *station == "" || *operation == "" || fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "apply requires --station ID --operation ID --plan-digest SHA256\n\n%s\n", configUsage)
			os.Exit(2)
		}
		if *planDigest == "" {
			fmt.Fprintf(os.Stderr, "apply requires --plan-digest SHA256 — the digest `plan` printed for\n"+
				"this operation. apply never falls back to re-deriving a plan: that would\n"+
				"discard the review a specific digest stands for.\n\n%s\n", configUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, "/api/stations/"+url.PathEscape(*station)+"/config/apply",
			map[string]string{"operationId": *operation, "planDigest": *planDigest})
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

// fleetConfigPlan resolves every setting currently declared for `station` —
// at any level, fleet, node or station — and asks the hub to plan writing
// all of them, each with `value` omitted so the hub resolves it from the
// declaration (the same resolution `plan --station ID` has no SETTING_ID
// flag to narrow: this is "the edit that would be made" for the station,
// not for one setting chosen on the command line).
//
// The GET is the same call `show --station` makes
// (`/api/stations/:stationId/config`), so a settingId this reports is
// exactly a settingId `planFor` on the hub will accept.
func fleetConfigPlan(station string) {
	base := "/api/stations/" + url.PathEscape(station) + "/config"
	raw := fleetRequestBytes(http.MethodGet, base, nil, "", 30*time.Second)
	var parsed struct {
		Observations []struct {
			SettingID string `json:"settingId"`
		} `json:"observations"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		fmt.Fprintln(os.Stderr, "the hub returned an unexpected response for this station's config")
		os.Exit(1)
	}
	seen := map[string]bool{}
	settings := make([]map[string]string, 0, len(parsed.Observations))
	for _, o := range parsed.Observations {
		if o.SettingID == "" || seen[o.SettingID] {
			continue
		}
		seen[o.SettingID] = true
		settings = append(settings, map[string]string{"settingId": o.SettingID})
	}
	if len(settings) == 0 {
		fmt.Fprintln(os.Stderr, "nothing is declared for this station; there is nothing to plan")
		os.Exit(1)
	}
	fleetSkillJSON(http.MethodPost, base+"/plan", map[string]any{"settings": settings})
}
