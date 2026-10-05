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
)

const configUsage = `usage:
  fleet config settings                                         every setting the fleet can declare
  fleet config show   [--node ID]                               the declarations themselves, as stored
  fleet config show   --station ID                              one station: declared vs observed, with state
  fleet config set    SETTING_ID --value V [--value V ...] [--station ID | --node ID]
  fleet config set    SETTING_ID --json  JSON          [--station ID | --node ID]
  fleet config unset  SETTING_ID [--station ID | --node ID]
  fleet config drift                                            every station whose value differs
  fleet config opt-out SETTING_ID [--station KEY | --node ID] [--reason TEXT]
  fleet config opt-in  SETTING_ID [--station KEY | --node ID]
  fleet config opt-out SETTING_ID [--station KEY | --node ID] --clear
  fleet config opt-out                                          what is exempt, and where
  fleet config plan    --station ID [--setting SETTING_ID]      narrow the plan to one setting
  fleet config inspect --station ID --operation ID              a plan already made, as it was reviewed
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
	"when the declaration is read back.\n\n" +
	"A single --value is always declared as a STRING. A setting whose value is a\n" +
	"list — every `additive-only` setting is one, a command allowlist being the\n" +
	"first — is declared either by repeating --value once per entry:\n\n" +
	"  fleet config set hermes.approvals.command_allowlist \\\n" +
	"      --value \"git status\" --value \"ls\"\n\n" +
	"or with --json, which takes the value exactly as JSON and is the way to\n" +
	"declare a ONE-entry list, a number or a boolean:\n\n" +
	"  fleet config set hermes.approvals.command_allowlist --json '[\"git status\"]'\n" +
	"  fleet config set hermes.approvals.timeout --json 900\n\n" +
	"--value and --json are mutually exclusive, and `set` needs one of them: a\n" +
	"declaration with no value is not a declaration. A list-valued setting given\n" +
	"a single --value is stored as the string it is, and every later plan for that\n" +
	"station is refused SHAPE_UNEXPECTED by the node, so the shape matters here\n" +
	"rather than at write time.\n\n" +
	"`opt-out` stops this system writing a setting; it does not change what is already in the file.\n" +
	"An exemption is not an undo — a station that was already drifted, or\n" +
	"already carries a value written before the exemption existed, stays\n" +
	"exactly as it is.\n\n" +
	"`opt-in` is not the same as `--clear`. `opt-in` records \"this station is\n" +
	"NOT exempt\", which overrides a node-level exemption for that one station.\n" +
	"`--clear` forgets the exemption row entirely, so the station falls back to\n" +
	"whatever the node says — if the node is exempt, the station is exempt\n" +
	"again too. Use `opt-in` to pin a station in despite its node; use --clear\n" +
	"to stop having an opinion at the station level at all.\n\n" +
	"A station-level row always beats a node-level one — `opt-in` at the\n" +
	"station overrides `opt-out` at the node, never the other way around.\n\n" +
	"--station names a station by its stationKey, not its row id: a stationKey\n" +
	"survives unadopt and re-adopt, so an exemption recorded against it still\n" +
	"applies after the station is re-adopted, which a row id would not."

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
		var values valueList
		fs.Var(&values, "value", "the declared value; repeat for a list")
		raw := fs.String("json", "", "the declared value, exactly as JSON")
		station := fs.String("station", "", "station ID")
		node := fs.String("node", "", "node ID")
		fs.Parse(args[2:])
		value, err := declaredValue(values, *raw)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%v\n\n%s\n", err, configUsage)
			os.Exit(2)
		}
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "value": value,
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
	case "opt-out":
		fleetConfigOptOut(args[1:])
	case "opt-in":
		id := needArg(args, 1, "opt-in", configUsage)
		fs := flag.NewFlagSet("fleet config opt-in", flag.ExitOnError)
		station := fs.String("station", "", "station key (survives unadopt/re-adopt; not a row id)")
		node := fs.String("node", "", "node ID")
		fs.Parse(args[2:])
		if fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "opt-in takes no extra positional arguments\n\n%s\n", configUsage)
			os.Exit(2)
		}
		requireExactlyOneScope("opt-in", *station, *node)
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "optedOut": false,
			"stationKey": nullable(*station), "nodeId": nullable(*node),
		})
		fleetSkillRequest(http.MethodPut, base+"/opt-out", bytes.NewReader(body), "application/json")
	case "plan":
		fs := flag.NewFlagSet("fleet config plan", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		setting := fs.String("setting", "", "narrow the plan to one setting")
		fs.Parse(args[1:])
		if *station == "" || fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "plan requires --station ID\n\n%s\n", configUsage)
			os.Exit(2)
		}
		fleetConfigPlan(*station, *setting)
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

// valueList collects a repeated --value, in the order given. `flag` has no
// built-in repeatable string, and the alternative — one comma-separated
// --value — cannot express an entry containing a comma, which a shell command
// in an allowlist very well might. Separate from `stringList` in stations.go
// because that one refuses an empty entry with a message about station keys.
type valueList []string

func (l *valueList) String() string {
	if l == nil {
		return ""
	}
	return strings.Join(*l, ", ")
}

func (l *valueList) Set(v string) error {
	*l = append(*l, v)
	return nil
}

// declaredValue turns what was typed into the value PUT to the hub.
//
// The hub stores this field verbatim as jsonb and the node refuses a shape its
// registry does not expect, so getting the JSON type right is the CLI's job
// and nobody else's: a single --value could only ever produce a JSON string,
// which made every `additive-only` setting — the whole reason this feature
// exists — impossible to declare from the command line. Three forms now:
//
//   - one --value        → that string, unchanged from before
//   - several --value    → a list of strings, in the order given
//   - --json             → exactly that JSON value, whatever its type
//
// --json is also the only way to say a ONE-entry list, which is why it exists
// alongside the repeatable flag rather than instead of it.
//
// An EMPTY --value is refused, as it always was: the flag's absence and an
// explicitly empty entry used to be one condition (`*value == ""`) and both
// exited 2, and an empty string in a command allowlist, or as an approvals
// mode, is far more likely a quoting mistake than a declaration. `--json '""'`
// says it on purpose.
func declaredValue(values valueList, raw string) (any, error) {
	for _, v := range values {
		if v == "" {
			return nil, fmt.Errorf("--value cannot be empty; use --json '\"\"' to declare the empty string on purpose")
		}
	}
	switch {
	case len(values) > 0 && raw != "":
		return nil, fmt.Errorf("set takes --value or --json, not both")
	case raw != "":
		var parsed any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			return nil, fmt.Errorf("--json is not valid JSON: %v", err)
		}
		return parsed, nil
	case len(values) == 1:
		return values[0], nil
	case len(values) > 1:
		return []string(values), nil
	default:
		return nil, fmt.Errorf("set requires --value (repeat it for a list) or --json")
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
		fs.Parse(rest)
		if fs.NArg() != 0 {
			fmt.Fprintf(os.Stderr, "opt-out without a SETTING_ID only lists; it takes no positional arguments\n\n%s\n", configUsage)
			os.Exit(2)
		}
		if *station != "" && *node != "" {
			fmt.Fprintf(os.Stderr, "opt-out takes --station or --node, not both\n\n%s\n", configUsage)
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
	fs.Parse(rest[1:])
	if fs.NArg() != 0 {
		fmt.Fprintf(os.Stderr, "opt-out takes no extra positional arguments\n\n%s\n", configUsage)
		os.Exit(2)
	}
	requireExactlyOneScope("opt-out", *station, *node)

	if *clear {
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "stationKey": nullable(*station), "nodeId": nullable(*node),
		})
		fleetSkillRequest(http.MethodDelete, path, bytes.NewReader(body), "application/json")
		return
	}
	payload := map[string]any{
		"settingId": id, "optedOut": true,
		"stationKey": nullable(*station), "nodeId": nullable(*node),
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
		fmt.Fprintf(os.Stderr, "%s takes --station or --node, not both\n\n%s\n", verb, configUsage)
		os.Exit(2)
	}
	if station == "" && node == "" {
		fmt.Fprintf(os.Stderr, "%s requires --station KEY or --node ID\n\n%s\n", verb, configUsage)
		os.Exit(2)
	}
}
