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
	"text/tabwriter"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcli"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/handoverseal"
)

var forgeAPIPresets = map[string]bool{"read": true, "issues": true, "pull-requests": true, "maintain": true, "none": true}

var forgeAPIProviders = map[string]bool{"forgejo": true, "github": true, "gitea": true, "bitbucket": true}

var forgeAPIModes = map[string]bool{"minted": true, "app": true, "supplied": true}

// forgeAPIFlags is every flag the forge-api verbs read. There is deliberately no flag that takes
// a credential: a token on the command line is in shell history and every process listing.
type forgeAPIFlags struct {
	fs                                                      *flag.FlagSet
	station, grant, provider, instance, preset, mode, login *string
	rulesFile                                               *string
	graphql, json, ackSameUser                              *bool
	repos, rules                                            stringList
}

func newForgeAPIFlags() *forgeAPIFlags {
	fs := flag.NewFlagSet("fleet stations forge-api", flag.ExitOnError)
	f := &forgeAPIFlags{fs: fs}
	f.station = fs.String("station", "", "station ID")
	f.grant = fs.String("grant", "", "grant ID, as `list` shows it")
	f.provider = fs.String("provider", "", "forgejo, github, gitea or bitbucket")
	f.instance = fs.String("instance", "", "the forge's https origin")
	f.preset = fs.String("preset", "", "read, issues, pull-requests, maintain or none")
	f.mode = fs.String("mode", "minted", "minted, app or supplied")
	f.login = fs.String("expect-login", "", "the account the credential must belong to (app: the App's slug)")
	f.rulesFile = fs.String("rules-file", "", "a JSON array of rules ({allow|deny, when}), added after --rule")
	f.graphql = fs.Bool("allow-graphql", false, "let the station use the GraphQL endpoint")
	f.json = fs.Bool("json", false, "list: print the same fields as JSON")
	f.ackSameUser = fs.Bool("acknowledge-same-user", false, "operator only: accept a write grant while the broker runs in same-user mode")
	fs.Var(&f.repos, "repo", "owner/name (repeatable)")
	fs.Var(&f.rules, "rule", "'allow: METHOD /path' or 'deny: METHOD /path' (repeatable)")
	return f
}

// fleetForgeAPI is `fleet stations forge-api <verb>`.
func fleetForgeAPI(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(fleetcli.ForgeAPIUsage)
		return
	}
	f := newForgeAPIFlags()
	_ = f.fs.Parse(args[1:]) // the FlagSet reports a bad flag itself
	if f.fs.NArg() != 0 {
		fleetcli.Refuse("unexpected argument %q", f.fs.Arg(0))
	}
	verb := args[0]
	switch verb {
	case "list", "grant", "verify", "rotate", "secret", "policy", "revoke", "confirm-revoked":
	default:
		fleetcli.Refuse("unknown forge-api command: %q (see `fleet stations forge-api --help`)", verb)
	}
	requireStation(*f.station, "forge-api "+verb)
	base := "/api/stations/" + url.PathEscape(*f.station) + "/forge-api"
	if verb != "list" && verb != "grant" && *f.grant == "" {
		fleetcli.Refuse("forge-api %s requires --grant GRANT_ID (see `fleet stations forge-api list`)", verb)
	}
	grantPath := base + "/" + url.PathEscape(*f.grant)

	switch verb {
	case "list":
		forgeAPIList(fleetRequestBytes(http.MethodGet, base, nil, "", forgeAPITimeout), *f.json)
	case "grant":
		forgeAPIGrant(f, base)
	case "verify", "rotate", "confirm-revoked":
		fleetSkillJSON(http.MethodPost, grantPath+"/"+verb, struct{}{})
	case "revoke":
		fleetSkillJSON(http.MethodDelete, grantPath, struct{}{})
	case "secret":
		material := fleetcli.ReadForgeCredential(forgeAPISecretMode(f))
		sealed := sealToStation(base, material)
		fleetSkillJSON(http.MethodPost, grantPath+"/secret", map[string]string{"sealed": sealed})
	case "policy":
		if *f.preset == "" {
			fleetcli.Refuse("forge-api policy requires --preset (it replaces the grant's preset, rules and GraphQL setting)")
		}
		preset, rules := policyOf(f)
		body := map[string]any{"preset": preset, "rules": rules, "allowGraphql": *f.graphql}
		if *f.ackSameUser {
			body["acknowledgeSameUser"] = true
		}
		fleetSkillJSON(http.MethodPatch, grantPath+"/policy", body)
	}
}

// forgeAPISecretMode is the material shape `secret` reads: an App's fields when --mode app is
// given, a token otherwise.
func forgeAPISecretMode(f *forgeAPIFlags) string {
	if *f.mode == "app" {
		return "app"
	}
	return "supplied"
}

const forgeAPITimeout = 75 * time.Second

// as the other mutating verbs

func forgeAPIGrant(f *forgeAPIFlags, base string) {
	if !forgeAPIProviders[*f.provider] {
		fleetcli.Refuse("forge-api grant requires --provider forgejo|github|gitea|bitbucket")
	}
	u, err := url.Parse(*f.instance)
	if *f.instance == "" || err != nil || u.Scheme != "https" || u.Host == "" {
		fleetcli.Refuse("forge-api grant requires --instance as an https origin, e.g. https://forge.example")
	}
	if len(f.repos) == 0 {
		fleetcli.Refuse("forge-api grant requires at least one --repo owner/name: a grant is never fleet-wide")
	}
	for _, r := range f.repos {
		if parts := strings.Split(r, "/"); len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			fleetcli.Refuse("--repo must be owner/name, got %q", r)
		}
	}
	if !forgeAPIModes[*f.mode] {
		fleetcli.Refuse("--mode must be minted, app or supplied")
	}
	if *f.preset == "" {
		*f.preset = "read"
	}
	preset, rules := policyOf(f)
	if *f.mode != "minted" && *f.login == "" {
		fleetcli.Refuse("--mode %s requires --expect-login (the account the credential must belong to; for an app, its slug)", *f.mode)
	}

	body := map[string]any{
		"provider": *f.provider, "instance": *f.instance, "mode": *f.mode,
		"repositories": []string(f.repos), "preset": preset, "rules": rules, "allowGraphql": *f.graphql,
	}
	if *f.login != "" {
		body["expectedLogin"] = *f.login
	}
	if *f.ackSameUser {
		body["acknowledgeSameUser"] = true
	}
	if *f.mode == "minted" {
		fleetSkillJSON(http.MethodPost, base, body)
		return
	}

	// Supplied/app: read and seal BEFORE creating anything, so a bad credential or an
	// unreachable station key leaves no half-made grant behind.
	material := fleetcli.ReadForgeCredential(*f.mode)
	sealed := sealToStation(base, material)
	created := forgeAPIPost(http.MethodPost, base, body)
	var view struct {
		Grant struct {
			ID string `json:"id"`
		} `json:"grant"`
	}
	if json.Unmarshal(created, &view) != nil || view.Grant.ID == "" {
		fmt.Fprintln(os.Stderr, "the hub did not return the new grant's id; nothing was sealed and sent")
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "grant %s created; sending its sealed credential (if this fails: fleet stations forge-api secret --station %s --grant %s --mode %s)\n",
		view.Grant.ID, *f.station, view.Grant.ID, *f.mode)
	fleetSkillJSON(http.MethodPost, base+"/"+url.PathEscape(view.Grant.ID)+"/secret", map[string]string{"sealed": sealed})
}

func forgeAPIPost(method, path string, payload any) []byte {
	b, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return fleetRequestBytes(method, path, bytes.NewReader(b), "application/json", forgeAPITimeout)
}

// policyOf validates --preset and turns --rule / --rules-file into the hub's rule objects.
func policyOf(f *forgeAPIFlags) (string, []map[string]any) {
	if !forgeAPIPresets[*f.preset] {
		fleetcli.Refuse("--preset must be read, issues, pull-requests, maintain or none")
	}
	rules := []map[string]any{}
	for _, r := range f.rules {
		rule, ok := fleetcli.ParseForgeRule(r)
		if !ok {
			fleetcli.Refuse("--rule must be 'allow: METHOD /path' or 'deny: METHOD /path', got %q", r)
		}
		rules = append(rules, rule)
	}
	if *f.rulesFile != "" {
		if *f.rulesFile == "-" {
			fleetcli.Refuse("--rules-file must be a file: stdin is reserved for the credential")
		}
		raw, err := os.ReadFile(*f.rulesFile)
		if err != nil {
			fleetcli.Refuse("--rules-file: could not read %s", *f.rulesFile)
		}
		var extra []map[string]any
		if err := json.Unmarshal(raw, &extra); err != nil {
			fleetcli.Refuse("--rules-file must be a JSON array of rules: %v", err)
		}
		rules = append(rules, extra...)
	}
	return *f.preset, rules
}

// sealToStation fetches the station's stk handover key (once) and seals the material to it.
func sealToStation(base string, material map[string]string) string {
	var key struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.Unmarshal(fleetRequestBytes(http.MethodGet, base+"/key", nil, "", forgeAPITimeout), &key); err != nil {
		fmt.Fprintln(os.Stderr, "the hub's key reply was not readable")
		os.Exit(1)
	}
	if _, err := handoverseal.ParsePublicKey(key.PublicKey); err != nil {
		fmt.Fprintf(os.Stderr, "the station's handover key is not usable: %v\n", err)
		os.Exit(1)
	}
	sealed, err := handoverseal.Seal(key.PublicKey, material)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sealing failed: %v\n", err)
		os.Exit(1)
	}
	if err := fleetcli.CheckEnvelope(sealed); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Before anything is created or sent: the hub would refuse it after the grant exists.
	if len(sealed) > fleetcli.ForgeSealedMax {
		fleetcli.Refuse("the sealed credential is %d characters; the hub accepts at most %d, so nothing was created or sent", len(sealed), fleetcli.ForgeSealedMax)
	}
	return sealed
}

func forgeAPIList(body []byte, asJSON bool) {
	var resp struct {
		Grants []fleetcli.ForgeGrantRow `json:"grants"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		fmt.Fprintln(os.Stderr, "the hub's reply was not readable")
		os.Exit(1)
	}
	if asJSON {
		out, _ := json.MarshalIndent(resp, "", "  ")
		fmt.Println(string(out))
		return
	}
	if len(resp.Grants) == 0 {
		fmt.Println("No forge API grants on this station.")
		return
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "GRANT\tSTATE\tMODE\tACCOUNT\tISOLATION\tPROVIDER\tINSTANCE\tPRESET\tREPOS")
	deref := func(s *string) string {
		if s == nil || *s == "" {
			return "-"
		}
		return *s
	}
	for _, g := range resp.Grants {
		state := g.State
		if g.Rotation != nil {
			state += " (rotation " + *g.Rotation + ")"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", g.ID, state, g.Mode, g.Account,
			deref(g.Isolation), g.Provider, g.Instance, g.Preset, strings.Join(g.Repositories, ","))
	}
	tw.Flush()
}
