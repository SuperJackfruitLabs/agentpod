package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcli"
)

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
		fmt.Println(fleetcli.ConfigUsage)
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
		_ = fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
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
		id := needArg(args, 1, "set", fleetcli.ConfigUsage)
		fs := flag.NewFlagSet("fleet config set", flag.ExitOnError)
		var values fleetcli.ValueList
		fs.Var(&values, "value", "the declared value; repeat for a list")
		raw := fs.String("json", "", "the declared value, exactly as JSON")
		station := fs.String("station", "", "station ID")
		node := fs.String("node", "", "node ID")
		_ = fs.Parse(args[2:]) // the FlagSet reports a bad flag itself
		value, err := fleetcli.DeclaredValue(values, *raw)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%v\n\n%s\n", err, fleetcli.ConfigUsage)
			os.Exit(2)
		}
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "value": value,
			"stationId": fleetcli.Nullable(*station), "nodeId": fleetcli.Nullable(*node),
		})
		fleetSkillRequest(http.MethodPut, base+"/declared", bytes.NewReader(body), "application/json")
	case "unset":
		id := needArg(args, 1, "unset", fleetcli.ConfigUsage)
		fs := flag.NewFlagSet("fleet config unset", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		node := fs.String("node", "", "node ID")
		_ = fs.Parse(args[2:]) // the FlagSet reports a bad flag itself
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "stationId": fleetcli.Nullable(*station), "nodeId": fleetcli.Nullable(*node),
		})
		fleetSkillRequest(http.MethodDelete, base+"/declared", bytes.NewReader(body), "application/json")
	case "opt-out":
		fleetConfigOptOut(args[1:])
	case "opt-in":
		id := needArg(args, 1, "opt-in", fleetcli.ConfigUsage)
		fs := flag.NewFlagSet("fleet config opt-in", flag.ExitOnError)
		station := fs.String("station", "", "station key (survives unadopt/re-adopt; not a row id)")
		node := fs.String("node", "", "node ID")
		_ = fs.Parse(args[2:]) // the FlagSet reports a bad flag itself
		if fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "opt-in takes no extra positional arguments\n\n%s\n", fleetcli.ConfigUsage)
			os.Exit(2)
		}
		requireExactlyOneScope("opt-in", *station, *node)
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "optedOut": false,
			"stationKey": fleetcli.Nullable(*station), "nodeId": fleetcli.Nullable(*node),
		})
		fleetSkillRequest(http.MethodPut, base+"/opt-out", bytes.NewReader(body), "application/json")
	case "plan":
		fs := flag.NewFlagSet("fleet config plan", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		setting := fs.String("setting", "", "narrow the plan to one setting")
		_ = fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
		if *station == "" || fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "plan requires --station ID\n\n%s\n", fleetcli.ConfigUsage)
			os.Exit(2)
		}
		fleetConfigPlan(*station, *setting)
	case "inspect":
		fs := flag.NewFlagSet("fleet config inspect", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		operation := fs.String("operation", "", "operation ID")
		_ = fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
		if *station == "" || *operation == "" || fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "inspect requires --station ID --operation ID\n\n%s\n", fleetcli.ConfigUsage)
			os.Exit(2)
		}
		fleetGet("/api/stations/"+url.PathEscape(*station)+"/config/operations/"+url.PathEscape(*operation), nil)
	case "apply":
		fs := flag.NewFlagSet("fleet config apply", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		operation := fs.String("operation", "", "operation ID")
		planDigest := fs.String("plan-digest", "", "reviewed plan digest")
		_ = fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
		if *station == "" || *operation == "" || fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "apply requires --station ID --operation ID --plan-digest SHA256\n\n%s\n", fleetcli.ConfigUsage)
			os.Exit(2)
		}
		if *planDigest == "" {
			fmt.Fprintf(os.Stderr, "apply requires --plan-digest SHA256 — the digest `plan` printed for\n"+
				"this operation. apply never falls back to re-deriving a plan: that would\n"+
				"discard the review a specific digest stands for.\n\n%s\n", fleetcli.ConfigUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, "/api/stations/"+url.PathEscape(*station)+"/config/apply",
			map[string]string{"operationId": *operation, "planDigest": *planDigest})
	default:
		fmt.Fprintln(os.Stderr, fleetcli.ConfigUsage)
		os.Exit(2)
	}
}

// fleetConfigPlan asks the hub to plan writing either one named setting
// (settingID non-empty — Plan 2's residual this clears: `plan --station ID`
// used to have no way to narrow to a single setting) or, when settingID is
// empty, every setting currently declared for `station` at any level —
// fleet, node or station. Either way `value` is omitted so the hub resolves
// it from the declaration: this is "the edit that would be made", not an
// edit chosen on the command line.
//
// With no settingID, the GET is the same call `show --station` makes
// (`/api/stations/:stationId/config`), so a settingId it reports is exactly
// a settingId `planFor` on the hub will accept. With a settingID, that GET
// is skipped entirely — there is nothing to resolve a one-entry list from.
func fleetConfigPlan(station, settingID string) {
	base := "/api/stations/" + url.PathEscape(station) + "/config"
	var settings []map[string]string
	if settingID != "" {
		settings = []map[string]string{{"settingId": settingID}}
	} else {
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
		settings = make([]map[string]string, 0, len(parsed.Observations))
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
	}
	fleetSkillJSON(http.MethodPost, base+"/plan", map[string]any{"settings": settings})
}

// fleetConfigOptOut handles every shape of the opt-out verb:
//
//   - no SETTING_ID: the listing form ("what is exempt, and where"), a GET
//     optionally filtered to one station or node.
//   - SETTING_ID, no --clear: a PUT recording optedOut:true, same shape
//     `opt-in` sends with optedOut:false.
//   - SETTING_ID, --clear: a DELETE that forgets the row entirely, distinct
//     from `opt-in` — see the `--clear` vs `opt-in` note in configUsage.
func fleetConfigOptOut(rest []string) {
	const path = "/api/fleet/config/opt-out"
	if len(rest) == 0 || strings.HasPrefix(rest[0], "-") {
		fs := flag.NewFlagSet("fleet config opt-out", flag.ExitOnError)
		station := fs.String("station", "", "station key")
		node := fs.String("node", "", "node ID")
		_ = fs.Parse(rest) // the FlagSet reports a bad flag itself
		if fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "opt-out without a SETTING_ID only lists; it takes no positional arguments\n\n%s\n", fleetcli.ConfigUsage)
			os.Exit(2)
		}
		if *station != "" && *node != "" {
			fmt.Fprintf(os.Stderr, "opt-out takes --station or --node, not both\n\n%s\n", fleetcli.ConfigUsage)
			os.Exit(2)
		}
		q := path
		params := url.Values{}
		if *station != "" {
			params.Set("stationKey", *station)
		}
		if *node != "" {
			params.Set("nodeId", *node)
		}
		if enc := params.Encode(); enc != "" {
			q += "?" + enc
		}
		fleetGet(q, nil)
		return
	}

	id := rest[0]
	fs := flag.NewFlagSet("fleet config opt-out", flag.ExitOnError)
	station := fs.String("station", "", "station key (survives unadopt/re-adopt; not a row id)")
	node := fs.String("node", "", "node ID")
	reason := fs.String("reason", "", "why this station or node is exempt")
	clear := fs.Bool("clear", false, "forget the exemption row instead of recording one; the station then falls back to the node level")
	_ = fs.Parse(rest[1:]) // the FlagSet reports a bad flag itself
	if fs.NArg() != 0 {
		fmt.Fprintf(os.Stderr, "opt-out takes no extra positional arguments\n\n%s\n", fleetcli.ConfigUsage)
		os.Exit(2)
	}
	requireExactlyOneScope("opt-out", *station, *node)

	if *clear {
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "stationKey": fleetcli.Nullable(*station), "nodeId": fleetcli.Nullable(*node),
		})
		fleetSkillRequest(http.MethodDelete, path, bytes.NewReader(body), "application/json")
		return
	}
	payload := map[string]any{
		"settingId": id, "optedOut": true,
		"stationKey": fleetcli.Nullable(*station), "nodeId": fleetcli.Nullable(*node),
	}
	if *reason != "" {
		payload["reason"] = *reason
	}
	body, _ := json.Marshal(payload)
	fleetSkillRequest(http.MethodPut, path, bytes.NewReader(body), "application/json")
}

// requireExactlyOneScope enforces the contract's own rule for an opt-out
// write — `(stationKey == null) !== (nodeId == null)` — before a request
// ever leaves this machine: naming both a station and a node is ambiguous,
// and naming neither is not an exemption of anything.
func requireExactlyOneScope(verb, station, node string) {
	if station != "" && node != "" {
		fmt.Fprintf(os.Stderr, "%s takes --station or --node, not both\n\n%s\n", verb, fleetcli.ConfigUsage)
		os.Exit(2)
	}
	if station == "" && node == "" {
		fmt.Fprintf(os.Stderr, "%s requires --station KEY or --node ID\n\n%s\n", verb, fleetcli.ConfigUsage)
		os.Exit(2)
	}
}
