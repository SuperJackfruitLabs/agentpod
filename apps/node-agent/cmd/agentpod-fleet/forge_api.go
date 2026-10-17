package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/handoverseal"
)

const forgeAPIUsage = `Usage: fleet stations forge-api <verb> --station STATION_ID [flags]

  list            --station ID                       grants: state, mode, account, isolation
  grant           --station ID --provider P --instance https://… --repo owner/name …
                  [--preset read|issues|pull-requests|maintain|none]
                  [--rule 'allow: METHOD /path']… [--rules-file FILE]
                  [--mode minted|app|supplied] [--expect-login LOGIN] [--allow-graphql]
  verify          --station ID --grant GRANT_ID      re-check the credential on the node
  rotate          --station ID --grant GRANT_ID      minted: a new token, the old one revoked
  secret          --station ID --grant GRANT_ID      re-supply a credential (stdin); add --mode app for an App
  policy          --station ID --grant GRANT_ID --preset P [--rule …]… [--rules-file FILE] [--allow-graphql]
                  replaces the whole policy: omitting --allow-graphql turns GraphQL OFF
  revoke          --station ID --grant GRANT_ID
  confirm-revoked --station ID --grant GRANT_ID      supplied: you revoked it at the provider

Granting an agent forge API access is an OPERATOR action (hub operator seat and the
control pair's reach). An agent must not try to grant itself access.

A supplied or app credential is read from STDIN, never from a flag: a token for
--mode supplied; for --mode app the lines app_id=…, installation_id=… and
private_key=… (the PEM may continue over the following lines). The CLI fetches
the station's handover key and seals the credential to it on this machine; the
hub only ever sees the sealed envelope. A minted grant needs no credential.`

var forgeAPIPresets = map[string]bool{"read": true, "issues": true, "pull-requests": true, "maintain": true, "none": true}
var forgeAPIProviders = map[string]bool{"forgejo": true, "github": true, "gitea": true, "bitbucket": true}
var forgeAPIModes = map[string]bool{"minted": true, "app": true, "supplied": true}

// forgeAPIFlags is every flag the forge-api verbs read. There is deliberately no flag that takes
// a credential: a token on the command line is in shell history and every process listing.
type forgeAPIFlags struct {
	fs                                                      *flag.FlagSet
	station, grant, provider, instance, preset, mode, login *string
	rulesFile                                               *string
	graphql, json                                           *bool
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
	fs.Var(&f.repos, "repo", "owner/name (repeatable)")
	fs.Var(&f.rules, "rule", "'allow: METHOD /path' or 'deny: METHOD /path' (repeatable)")
	return f
}

func refuse(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(2)
}

// fleetForgeAPI is `fleet stations forge-api <verb>`.
func fleetForgeAPI(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(forgeAPIUsage)
		return
	}
	f := newForgeAPIFlags()
	f.fs.Parse(args[1:])
	if f.fs.NArg() != 0 {
		refuse("unexpected argument %q", f.fs.Arg(0))
	}
	verb := args[0]
	switch verb {
	case "list", "grant", "verify", "rotate", "secret", "policy", "revoke", "confirm-revoked":
	default:
		refuse("unknown forge-api command: %q (see `fleet stations forge-api --help`)", verb)
	}
	requireStation(*f.station, "forge-api "+verb)
	base := "/api/stations/" + url.PathEscape(*f.station) + "/forge-api"
	if verb != "list" && verb != "grant" && *f.grant == "" {
		refuse("forge-api %s requires --grant GRANT_ID (see `fleet stations forge-api list`)", verb)
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
		material := readForgeCredential(forgeAPISecretMode(f))
		sealed := sealToStation(base, material)
		fleetSkillJSON(http.MethodPost, grantPath+"/secret", map[string]string{"sealed": sealed})
	case "policy":
		if *f.preset == "" {
			refuse("forge-api policy requires --preset (it replaces the grant's preset, rules and GraphQL setting)")
		}
		preset, rules := policyOf(f)
		fleetSkillJSON(http.MethodPatch, grantPath+"/policy",
			map[string]any{"preset": preset, "rules": rules, "allowGraphql": *f.graphql})
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

const forgeAPITimeout = 75 * time.Second // as the other mutating verbs

func forgeAPIGrant(f *forgeAPIFlags, base string) {
	if !forgeAPIProviders[*f.provider] {
		refuse("forge-api grant requires --provider forgejo|github|gitea|bitbucket")
	}
	u, err := url.Parse(*f.instance)
	if *f.instance == "" || err != nil || u.Scheme != "https" || u.Host == "" {
		refuse("forge-api grant requires --instance as an https origin, e.g. https://forge.example")
	}
	if len(f.repos) == 0 {
		refuse("forge-api grant requires at least one --repo owner/name: a grant is never fleet-wide")
	}
	for _, r := range f.repos {
		if parts := strings.Split(r, "/"); len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			refuse("--repo must be owner/name, got %q", r)
		}
	}
	if !forgeAPIModes[*f.mode] {
		refuse("--mode must be minted, app or supplied")
	}
	if *f.preset == "" {
		*f.preset = "read"
	}
	preset, rules := policyOf(f)
	if *f.mode != "minted" && *f.login == "" {
		refuse("--mode %s requires --expect-login (the account the credential must belong to; for an app, its slug)", *f.mode)
	}

	body := map[string]any{
		"provider": *f.provider, "instance": *f.instance, "mode": *f.mode,
		"repositories": []string(f.repos), "preset": preset, "rules": rules, "allowGraphql": *f.graphql,
	}
	if *f.login != "" {
		body["expectedLogin"] = *f.login
	}
	if *f.mode == "minted" {
		fleetSkillJSON(http.MethodPost, base, body)
		return
	}

	// Supplied/app: read and seal BEFORE creating anything, so a bad credential or an
	// unreachable station key leaves no half-made grant behind.
	material := readForgeCredential(*f.mode)
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
		refuse("--preset must be read, issues, pull-requests, maintain or none")
	}
	rules := []map[string]any{}
	for _, r := range f.rules {
		rule, ok := parseForgeRule(r)
		if !ok {
			refuse("--rule must be 'allow: METHOD /path' or 'deny: METHOD /path', got %q", r)
		}
		rules = append(rules, rule)
	}
	if *f.rulesFile != "" {
		if *f.rulesFile == "-" {
			refuse("--rules-file must be a file: stdin is reserved for the credential")
		}
		raw, err := os.ReadFile(*f.rulesFile)
		if err != nil {
			refuse("--rules-file: could not read %s", *f.rulesFile)
		}
		var extra []map[string]any
		if err := json.Unmarshal(raw, &extra); err != nil {
			refuse("--rules-file must be a JSON array of rules: %v", err)
		}
		rules = append(rules, extra...)
	}
	return *f.preset, rules
}

// parseForgeRule reads "allow: POST /repos/o/r/issues" into {"allow": "POST /repos/o/r/issues"}.
func parseForgeRule(s string) (map[string]any, bool) {
	kind, rest, ok := strings.Cut(s, ":")
	kind, rest = strings.TrimSpace(kind), strings.TrimSpace(rest)
	if !ok || (kind != "allow" && kind != "deny") {
		return nil, false
	}
	method, path, ok := strings.Cut(rest, " ")
	path = strings.TrimSpace(path)
	if !ok || method == "" || method != strings.ToUpper(method) || !strings.HasPrefix(path, "/") {
		return nil, false
	}
	return map[string]any{kind: method + " " + path}, true
}

const forgeCredentialMax = 64 * 1024

// forgeSealedMax is the hub's cap on a supplied/app envelope (contract FORGE_API_SEALED_MAX, held
// to it by TestForgeSealedMaxMatchesTheContract). Checked after sealing and before the grant exists.
const forgeSealedMax = 16384

// readForgeCredential reads the credential from stdin. Errors never quote what was read.
func readForgeCredential(mode string) map[string]string {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, forgeCredentialMax+1))
	if err != nil {
		refuse("could not read the credential from stdin")
	}
	if len(raw) > forgeCredentialMax {
		refuse("the credential on stdin is larger than 64 KiB")
	}
	text := strings.TrimSpace(string(raw))
	if text == "" {
		refuse("--mode %s reads the credential from stdin, and stdin was empty", mode)
	}
	if mode != "app" {
		if strings.ContainsAny(text, "\r\n \t") {
			refuse("a supplied token is one line with no spaces; stdin had more")
		}
		return map[string]string{"token": text}
	}
	m := map[string]string{}
	last := ""
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 0, 4096), forgeCredentialMax)
	for sc.Scan() {
		line := sc.Text()
		if k, v, ok := strings.Cut(line, "="); ok && (k == "app_id" || k == "installation_id" || k == "private_key") {
			if _, dup := m[k]; dup {
				refuse("stdin names %s twice", k)
			}
			m[k], last = strings.TrimSpace(v), k
			continue
		}
		if last != "private_key" {
			refuse("an app credential is the lines app_id=…, installation_id=… and private_key=… on stdin")
		}
		m[last] += "\n" + line
	}
	for _, k := range []string{"app_id", "installation_id", "private_key"} {
		if m[k] == "" {
			refuse("the app credential on stdin lacks %s=…", k)
		}
	}
	m["private_key"] = strings.TrimSpace(m["private_key"])
	return m
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
	if err := checkEnvelope(sealed); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Before anything is created or sent: the hub would refuse it after the grant exists.
	if len(sealed) > forgeSealedMax {
		refuse("the sealed credential is %d characters; the hub accepts at most %d, so nothing was created or sent", len(sealed), forgeSealedMax)
	}
	return sealed
}

// checkEnvelope refuses to send anything that is not a sealed envelope. Its message is fixed: it
// never quotes the value, which could be plaintext if the sealer were ever wrong.
func checkEnvelope(s string) error {
	if !strings.HasPrefix(s, handoverEnvelopePrefix) {
		return fmt.Errorf("sealing did not produce a sealed envelope; nothing was sent")
	}
	return nil
}

const handoverEnvelopePrefix = "stk-handover-v1:"

// forgeGrantRow is every field `list` prints. Only these are decoded, so a field the CLI does not
// know — even one a faulty hub should never send — is never printed.
type forgeGrantRow struct {
	ID           string   `json:"id"`
	Provider     string   `json:"provider"`
	Instance     string   `json:"instance"`
	Mode         string   `json:"mode"`
	Account      string   `json:"account"`
	Repositories []string `json:"repositories"`
	Preset       string   `json:"preset"`
	State        string   `json:"state"`
	StateReason  *string  `json:"stateReason"`
	Isolation    *string  `json:"isolation"`
	Rotation     *string  `json:"rotation"`
}

func forgeAPIList(body []byte, asJSON bool) {
	var resp struct {
		Grants []forgeGrantRow `json:"grants"`
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
