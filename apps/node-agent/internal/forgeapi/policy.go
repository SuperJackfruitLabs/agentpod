package forgeapi

// The stk policy file (supertoolkit.yaml), as the node edits it.
//
// stk reads the whole file on `stk reload` and refuses to load it if ANY entry is bad, so the
// node's rules are: write only entries stk's own loader accepts (the strict keys below are
// copied from stk's internal/policy and internal/catalog/forge.go, supertoolkit commit 9fc1c19),
// leave everything the node did not write exactly as the operator had it, and never hand stk a
// file the node has not checked.
//
// Comments: the file is edited through the YAML node tree (go.yaml.in/yaml/v3), which keeps
// comments, key order and unknown keys. It does NOT keep byte-identical formatting: the first
// write by the node re-emits the file with two-space indentation and normalised scalar quoting.
// A comment survives; its column or blank lines around it may move. After that first
// normalisation a replay of the same entry produces the same bytes.

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Errors a caller can test with errors.Is.
var (
	// ErrReservedName: the service name is one of stk's built-in services.
	ErrReservedName = errors.New("service name collides with a built-in stk service")
	// ErrInvalidEntry: the entry is malformed; stk would refuse it.
	ErrInvalidEntry = errors.New("invalid policy entry")
	// ErrConflict: another service already owns this name, host or environment variable.
	ErrConflict = errors.New("policy conflict")
	// ErrBadPolicyFile: the existing file is not something the node can edit safely.
	ErrBadPolicyFile = errors.New("existing policy file cannot be edited")
)

// BuiltinServices are the names of stk's compiled-in services (`catalog.builtin` in
// supertoolkit, commit 9fc1c19). A forge service may not take one: stk resolves a name without
// `kind: forge` against this table, and a collision would silently change what the entry is.
// A test holds this list to its recorded value; refresh both when stk adds a service.
var BuiltinServices = []string{
	"aws-sts", "github-app", "x", "slack", "notion", "google",
	"stripe", "openai", "cloudflare", "resend", "github",
}

// MarkerLabel is the label key that marks an entry as written by this node. stk accepts exactly
// three label keys (station, principal, grant) and fails the whole file on any other, so the
// marker is the presence of `grant`, not a key of our own.
const MarkerLabel = "grant"

// Rule is one request rule of a forge service: exactly one of Allow or Deny, optionally with a
// body condition. The node passes it through; stk parses it.
type Rule struct {
	Allow string         `json:"allow,omitempty" yaml:"allow,omitempty"`
	Deny  string         `json:"deny,omitempty" yaml:"deny,omitempty"`
	When  map[string]any `json:"when,omitempty" yaml:"when,omitempty"`
}

// PolicyEntry is one forge grant as an stk policy entry.
type PolicyEntry struct {
	Service      string // stk service name, e.g. forge-forgejo-abc123
	Provider     string // forgejo | gitea | github | bitbucket
	Instance     string // base URL of the forge; stk wants only its host
	Mode         string // minted | app | supplied
	Repositories []string
	Preset       string
	Rules        []Rule
	AllowGraphQL bool
	// Labels are copied onto every audit row stk writes.
	Station   string
	Principal string // optional; the deliver frame does not carry it today
	Grant     string
	// EnvVar overrides the derived environment variable name (rarely set).
	EnvVar string
}

var (
	serviceNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	envVarRE      = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)
	repoRE        = regexp.MustCompile(`^[^/\s]+/[^/\s]+$`)
	providers     = map[string]bool{"forgejo": true, "gitea": true, "github": true, "bitbucket": true}
	modes         = map[string]bool{"minted": true, "app": true, "supplied": true}
	presets       = map[string]bool{"read": true, "issues": true, "pull-requests": true, "maintain": true, "none": true}
)

const maxLabelLen = 128

// conventionalEnvVar is the variable name each forge's own tooling reads.
var conventionalEnvVar = map[string]string{
	"forgejo": "FORGEJO_TOKEN", "gitea": "GITEA_TOKEN", "github": "GH_TOKEN", "bitbucket": "BITBUCKET_TOKEN",
}

// ValidatePreset reports whether p is a preset stk knows.
func ValidatePreset(p string) bool { return presets[p] }

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidEntry, fmt.Sprintf(format, a...))
}

// CheckServiceName applies stk's name rules plus the built-in collision rule.
func CheckServiceName(name string) error {
	if !serviceNameRE.MatchString(name) {
		return invalid("service name %q is not a valid stk service name", name)
	}
	if strings.Contains(name, ".scope-") {
		return invalid("service name may not contain .scope-")
	}
	for _, b := range BuiltinServices {
		if name == b {
			return fmt.Errorf("%w: %q", ErrReservedName, name)
		}
	}
	return nil
}

// ValidateRules checks the shape stk requires of `rules:` items. The patterns themselves are
// stk's to parse; a bad one is caught by the reload and rolled back.
func ValidateRules(rules []Rule) error {
	for i, r := range rules {
		if (r.Allow == "") == (r.Deny == "") {
			return invalid("rule %d: want exactly one of allow or deny", i+1)
		}
	}
	return nil
}

func checkLabel(key, v string, required bool) error {
	if v == "" {
		if required {
			return invalid("label %s is required", key)
		}
		return nil
	}
	if len(v) > maxLabelLen {
		return invalid("label %s is longer than %d bytes", key, maxLabelLen)
	}
	for _, r := range v {
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
			return invalid("label %s contains a control character", key)
		}
	}
	return nil
}

// HostFor derives the host stk intercepts from the forge's base URL. stk takes a bare hostname:
// it brokers HTTPS only, has no port syntax and no sub-path installs (api_prefix is the forge's
// API prefix, not an instance sub-path), so an instance that needs either is refused rather than
// written as an entry that would silently never match. github.com and bitbucket.org have a
// dedicated API host.
func HostFor(provider, instance string) (string, error) {
	u, err := url.Parse(instance)
	if err != nil || u.Host == "" {
		return "", invalid("instance %q is not a URL", instance)
	}
	if u.Scheme != "https" {
		return "", invalid("instance must be https: stk brokers TLS only")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", invalid("instance must be a plain base URL")
	}
	if p := strings.Trim(u.Path, "/"); p != "" {
		return "", invalid("instance with a path (%q) is not supported: stk matches a bare host", u.Path)
	}
	if u.Port() != "" {
		return "", invalid("instance with a port is not supported: stk matches a bare hostname")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || strings.ContainsAny(host, "/: \t\r\n?#@") {
		return "", invalid("instance host %q is not a bare hostname", host)
	}
	switch {
	case provider == "github" && host == "github.com":
		host = "api.github.com"
	case provider == "bitbucket" && host == "bitbucket.org":
		host = "api.bitbucket.org"
	}
	return host, nil
}

func (e PolicyEntry) validate() error {
	if err := CheckServiceName(e.Service); err != nil {
		return err
	}
	if !providers[e.Provider] {
		return invalid("unknown provider %q", e.Provider)
	}
	if !modes[e.Mode] {
		return invalid("unknown mode %q", e.Mode)
	}
	if e.Mode == "app" && e.Provider != "github" {
		return invalid("mode app is a GitHub App grant; provider %q has none", e.Provider)
	}
	if !presets[e.Preset] {
		return invalid("unknown preset %q", e.Preset)
	}
	if len(e.Repositories) == 0 {
		return invalid("repositories is required")
	}
	for _, r := range e.Repositories {
		if !repoRE.MatchString(r) {
			return invalid("repository %q must be owner/name", r)
		}
	}
	if err := ValidateRules(e.Rules); err != nil {
		return err
	}
	if err := checkLabel("station", e.Station, true); err != nil {
		return err
	}
	if err := checkLabel("grant", e.Grant, true); err != nil {
		return err
	}
	if strings.HasPrefix(e.Grant, SharedGrantPrefix) {
		return invalid("grant %q uses the shared-entry marker", e.Grant)
	}
	if err := checkLabel("principal", e.Principal, false); err != nil {
		return err
	}
	if e.EnvVar != "" && !envVarRE.MatchString(e.EnvVar) {
		return invalid("env var %q is not a valid variable name", e.EnvVar)
	}
	return nil
}

// schemeFor is the credential placement per provider (ledger ruling): Forgejo and Gitea document
// `Authorization: token <t>`; GitHub and Bitbucket take Bearer.
func schemeFor(provider string) string {
	if provider == "forgejo" || provider == "gitea" {
		return "token"
	}
	return "bearer"
}

func authFor(mode string) string {
	if mode == "app" {
		return "app"
	}
	return "token"
}

// derivedEnvVar is AGENTPOD_FORGE_<first 8 of the grant's random part>_TOKEN.
func derivedEnvVar(grant string) string {
	id := grant
	if i := strings.LastIndex(id, "_"); i >= 0 {
		id = id[i+1:]
	}
	var b strings.Builder
	for _, r := range strings.ToUpper(id) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
		if b.Len() == 8 {
			break
		}
	}
	return "AGENTPOD_FORGE_" + b.String() + "_TOKEN"
}

type ruleOut struct {
	Allow string         `yaml:"allow,omitempty"`
	Deny  string         `yaml:"deny,omitempty"`
	When  map[string]any `yaml:"when,omitempty"`
}

type labelsOut struct {
	Station   string `yaml:"station"`
	Principal string `yaml:"principal,omitempty"`
	Grant     string `yaml:"grant"`
}

type serviceOut struct {
	Kind         string    `yaml:"kind"`
	Provider     string    `yaml:"provider"`
	Host         string    `yaml:"host"`
	Auth         string    `yaml:"auth"`
	Scheme       string    `yaml:"scheme"`
	EnvVar       string    `yaml:"env_var"`
	Repositories []string  `yaml:"repositories"`
	Preset       string    `yaml:"preset"`
	Rules        []ruleOut `yaml:"rules,omitempty"`
	AllowGraphQL bool      `yaml:"allow_graphql"`
	Labels       labelsOut `yaml:"labels"`
}

func toRulesOut(rs []Rule) []ruleOut {
	out := make([]ruleOut, len(rs))
	for i, r := range rs {
		out[i] = ruleOut{Allow: r.Allow, Deny: r.Deny, When: r.When}
	}
	return out
}

// RenderPolicy returns a policy file holding only this entry. It is MergePolicy over an empty
// file, so a fresh install and an edit produce the same entry bytes.
func RenderPolicy(entry PolicyEntry) ([]byte, error) { return MergePolicy(nil, entry) }

// MergePolicy returns existing with entry added, or replaced if a service of that name written
// for the same grant is already there. It is pure and changes nothing else: other services,
// unknown top-level keys and comments are kept (see the package comment for what "kept" means).
//
// It refuses: an invalid entry; a name that collides with a built-in; a name already used by a
// service that is not this grant's (an operator's entry is never overwritten); a host or
// environment variable another service already uses (stk allows one service per host).
func MergePolicy(existing []byte, entry PolicyEntry) ([]byte, error) {
	if err := entry.validate(); err != nil {
		return nil, err
	}
	host, err := HostFor(entry.Provider, entry.Instance)
	if err != nil {
		return nil, err
	}
	doc, services, err := loadDoc(existing, true)
	if err != nil {
		return nil, err
	}

	var self *yaml.Node
	usedHosts := map[string]string{}
	usedEnv := map[string]string{}
	for i := 0; i+1 < len(services.Content); i += 2 {
		name, val := services.Content[i].Value, services.Content[i+1]
		if name == entry.Service {
			if g := labelOf(val, MarkerLabel); g != entry.Grant {
				return nil, fmt.Errorf("%w: service %q already exists and is not grant %s's", ErrConflict, name, entry.Grant)
			}
			self = val
			continue
		}
		if g := labelOf(val, MarkerLabel); g == entry.Grant {
			return nil, fmt.Errorf("%w: grant %s is already stored as service %q", ErrConflict, entry.Grant, name)
		}
		if h := scalarOf(val, "host"); h != "" {
			usedHosts[strings.ToLower(h)] = name
		}
		if v := scalarOf(val, "env_var"); v != "" {
			usedEnv[v] = name
		}
	}
	if other, ok := usedHosts[host]; ok {
		return nil, fmt.Errorf("%w: host %s is already brokered by service %q: stk allows one service per host", ErrConflict, host, other)
	}

	envVar := entry.EnvVar
	if envVar == "" && self != nil {
		// A replay keeps the name it already has, so a grant never changes variable because a
		// neighbour came or went.
		envVar = scalarOf(self, "env_var")
	}
	if envVar == "" {
		envVar = conventionalEnvVar[entry.Provider]
		if _, taken := usedEnv[envVar]; taken {
			envVar = derivedEnvVar(entry.Grant)
		}
	}
	if other, taken := usedEnv[envVar]; taken {
		return nil, fmt.Errorf("%w: environment variable %s is already used by service %q", ErrConflict, envVar, other)
	}

	out := serviceOut{
		Kind: "forge", Provider: entry.Provider, Host: host,
		Auth: authFor(entry.Mode), Scheme: schemeFor(entry.Provider), EnvVar: envVar,
		Repositories: append([]string{}, entry.Repositories...), Preset: entry.Preset,
		Rules: toRulesOut(entry.Rules), AllowGraphQL: entry.AllowGraphQL,
		Labels: labelsOut{Station: entry.Station, Principal: entry.Principal, Grant: entry.Grant},
	}
	var node yaml.Node
	if err := node.Encode(out); err != nil {
		return nil, fmt.Errorf("render policy entry: %w", err)
	}
	if self != nil {
		*self = node
	} else {
		key := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: entry.Service,
			HeadComment: "managed by agentpod-node (forge API grant); do not edit"}
		services.Content = append(services.Content, key, &node)
	}
	return encodeDoc(doc)
}

// ManagedEntry is a policy entry the node wrote: a forge service carrying a grant label.
type ManagedEntry struct {
	Service, Station, Principal, Grant string
	// Host is the forge host the entry brokers (the harness wiring warns when a NO_PROXY covers it).
	Host string
}

// ManagedEntries lists the node's entries in file order.
func ManagedEntries(existing []byte) ([]ManagedEntry, error) {
	_, services, err := loadDoc(existing, false)
	if err != nil {
		return nil, err
	}
	var out []ManagedEntry
	if services == nil {
		return out, nil
	}
	for i := 0; i+1 < len(services.Content); i += 2 {
		val := services.Content[i+1]
		if scalarOf(val, "kind") != "forge" {
			continue
		}
		g := labelOf(val, MarkerLabel)
		if g == "" || strings.HasPrefix(g, SharedGrantPrefix) {
			continue
		}
		out = append(out, ManagedEntry{
			Service: services.Content[i].Value, Grant: g,
			Station: labelOf(val, "station"), Principal: labelOf(val, "principal"),
			Host: scalarOf(val, "host"),
		})
	}
	return out, nil
}

// FindGrant returns the managed entry for a grant (and station, when station is not empty).
func FindGrant(existing []byte, station, grant string) (ManagedEntry, bool, error) {
	all, err := ManagedEntries(existing)
	if err != nil {
		return ManagedEntry{}, false, err
	}
	for _, m := range all {
		if m.Grant == grant && (station == "" || m.Station == station) {
			return m, true, nil
		}
	}
	return ManagedEntry{}, false, nil
}

// UpdatePolicy replaces the preset, rules and allow_graphql of the managed entry for a grant and
// touches nothing else in the entry or the file. found is false when no managed entry matches.
func UpdatePolicy(existing []byte, station, grant, preset string, rules []Rule, allowGraphQL bool) (out []byte, found bool, err error) {
	if !presets[preset] {
		return nil, false, invalid("unknown preset %q", preset)
	}
	if err := ValidateRules(rules); err != nil {
		return nil, false, err
	}
	doc, services, err := loadDoc(existing, false)
	if err != nil {
		return nil, false, err
	}
	if services == nil {
		return existing, false, nil
	}
	for i := 0; i+1 < len(services.Content); i += 2 {
		val := services.Content[i+1]
		if scalarOf(val, "kind") != "forge" || labelOf(val, MarkerLabel) != grant || strings.HasPrefix(grant, SharedGrantPrefix) {
			continue
		}
		if station != "" && labelOf(val, "station") != station {
			continue
		}
		var p, a, r yaml.Node
		if err := p.Encode(preset); err != nil {
			return nil, false, err
		}
		if err := a.Encode(allowGraphQL); err != nil {
			return nil, false, err
		}
		setKey(val, "preset", &p)
		setKey(val, "allow_graphql", &a)
		if len(rules) == 0 {
			delKey(val, "rules")
		} else {
			if err := r.Encode(toRulesOut(rules)); err != nil {
				return nil, false, err
			}
			setKey(val, "rules", &r)
		}
		b, err := encodeDoc(doc)
		return b, true, err
	}
	return existing, false, nil
}

// RemoveEntries deletes the managed entries for the given grants. removed lists the services
// taken out. Entries the node did not write are never touched.
func RemoveEntries(existing []byte, grants map[string]bool) (out []byte, removed []string, err error) {
	doc, services, err := loadDoc(existing, false)
	if err != nil {
		return nil, nil, err
	}
	if services == nil {
		return existing, nil, nil
	}
	kept := services.Content[:0:0]
	for i := 0; i+1 < len(services.Content); i += 2 {
		val := services.Content[i+1]
		if g := labelOf(val, MarkerLabel); g != "" && !strings.HasPrefix(g, SharedGrantPrefix) && scalarOf(val, "kind") == "forge" && grants[g] {
			removed = append(removed, services.Content[i].Value)
			continue
		}
		kept = append(kept, services.Content[i], val)
	}
	if len(removed) == 0 {
		return existing, nil, nil
	}
	services.Content = kept
	b, err := encodeDoc(doc)
	sort.Strings(removed)
	return b, removed, err
}

// loadDoc parses the file into a node tree and returns the `services` mapping. With create the
// document and mapping are made when absent; without it, a missing services mapping is nil.
func loadDoc(existing []byte, create bool) (doc, services *yaml.Node, err error) {
	doc = &yaml.Node{}
	if len(bytes.TrimSpace(existing)) > 0 {
		if err := yaml.Unmarshal(existing, doc); err != nil {
			return nil, nil, fmt.Errorf("%w: not valid YAML: %v", ErrBadPolicyFile, err)
		}
	}
	if doc.Kind == 0 || (doc.Kind == yaml.DocumentNode && len(doc.Content) == 0) {
		doc = &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 {
		return nil, nil, fmt.Errorf("%w: expected a single YAML document", ErrBadPolicyFile)
	}
	root := doc.Content[0]
	if root.Kind == yaml.ScalarNode && root.Tag == "!!null" {
		root = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		doc.Content[0] = root
	}
	if root.Kind != yaml.MappingNode {
		return nil, nil, fmt.Errorf("%w: the top level is not a mapping", ErrBadPolicyFile)
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value != "services" {
			continue
		}
		v := root.Content[i+1]
		if v.Kind == yaml.ScalarNode && v.Tag == "!!null" {
			v = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			root.Content[i+1] = v
		}
		if v.Kind != yaml.MappingNode {
			return nil, nil, fmt.Errorf("%w: services is not a mapping", ErrBadPolicyFile)
		}
		if len(v.Content) == 0 {
			v.Style = 0 // `services: {}` must not make every entry added later flow-style
		}
		return doc, v, nil
	}
	if !create {
		return doc, nil, nil
	}
	services = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "services"}, services)
	return doc, services, nil
}

func encodeDoc(doc *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, fmt.Errorf("render policy file: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("render policy file: %w", err)
	}
	return buf.Bytes(), nil
}

func mapGet(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

func scalarOf(m *yaml.Node, key string) string {
	if v := mapGet(m, key); v != nil && v.Kind == yaml.ScalarNode {
		return v.Value
	}
	return ""
}

func labelOf(m *yaml.Node, key string) string { return scalarOf(mapGet(m, "labels"), key) }

func setKey(m *yaml.Node, key string, v *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content[i+1] = v
			return
		}
	}
	m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, v)
}

func delKey(m *yaml.Node, key string) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return
		}
	}
}
