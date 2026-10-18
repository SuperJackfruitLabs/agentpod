package forgeapi

import (
	"bytes"
	"errors"
	"sort"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func baseEntry() PolicyEntry {
	return PolicyEntry{
		Service: "forge-forgejo-aaa111", Provider: "forgejo", Instance: "https://forge.example.com",
		Mode: "minted", Repositories: []string{"acme/widgets"}, Preset: "read",
		Station: "stn_1", Grant: "fag_aaa111",
	}
}

func TestRenderPolicyIsMergeOverNothing(t *testing.T) {
	r, err := RenderPolicy(baseEntry())
	if err != nil {
		t.Fatal(err)
	}
	m, err := MergePolicy(nil, baseEntry())
	if err != nil || !bytes.Equal(r, m) {
		t.Fatalf("RenderPolicy != MergePolicy(nil): %v", err)
	}
}

// The strict key set stk's loader accepts for a forge service and its labels
// (supertoolkit internal/policy/config.go `file` and `labelKeys`). Decoding with KnownFields is
// the closest a unit test gets to "stk would load this" without stk.
type stkService struct {
	Kind         string            `yaml:"kind"`
	Provider     string            `yaml:"provider"`
	Host         string            `yaml:"host"`
	APIPrefix    string            `yaml:"api_prefix"`
	Auth         string            `yaml:"auth"`
	Scheme       string            `yaml:"scheme"`
	EnvVar       string            `yaml:"env_var"`
	Repositories []string          `yaml:"repositories"`
	Preset       string            `yaml:"preset"`
	Rules        []stkRule         `yaml:"rules"`
	AllowGraphQL *bool             `yaml:"allow_graphql"`
	Labels       map[string]string `yaml:"labels"`
}
type stkRule struct {
	Allow string         `yaml:"allow"`
	Deny  string         `yaml:"deny"`
	When  map[string]any `yaml:"when"`
}

func decodeStk(t *testing.T, b []byte) map[string]stkService {
	t.Helper()
	// Top level is lenient in stk (unknown keys ignored); service entries are what we hold strict.
	var raw map[string]any
	if err := yaml.Unmarshal(b, &raw); err != nil {
		t.Fatalf("not YAML: %v", err)
	}
	svcs, _ := raw["services"].(map[string]any)
	out := map[string]stkService{}
	for name, v := range svcs {
		sb, _ := yaml.Marshal(v)
		var s stkService
		d := yaml.NewDecoder(bytes.NewReader(sb))
		d.KnownFields(true)
		if err := d.Decode(&s); err != nil {
			t.Fatalf("service %s uses a key stk would not accept: %v\n%s", name, err, sb)
		}
		out[name] = s
	}
	return out
}

func TestEntryUsesOnlyKeysStkAccepts(t *testing.T) {
	e := baseEntry()
	e.Principal = "agent-press"
	e.Rules = []Rule{{Allow: "POST /repos/{owner}/{repo}/issues", When: map[string]any{"title": "x"}}, {Deny: "DELETE /x"}}
	e.AllowGraphQL = true
	b, err := RenderPolicy(e)
	if err != nil {
		t.Fatal(err)
	}
	s := decodeStk(t, b)["forge-forgejo-aaa111"]
	if s.Kind != "forge" || s.Provider != "forgejo" || s.Host != "forge.example.com" || s.Scheme != "token" || s.Auth != "token" ||
		s.EnvVar != "FORGEJO_TOKEN" || s.Preset != "read" || len(s.Rules) != 2 || s.AllowGraphQL == nil || !*s.AllowGraphQL {
		t.Fatalf("decoded = %+v", s)
	}
	if s.APIPrefix != "" {
		t.Error("api_prefix must be left to stk's provider defaults")
	}
	if len(s.Labels) != 3 || s.Labels["station"] != "stn_1" || s.Labels["principal"] != "agent-press" || s.Labels["grant"] != "fag_aaa111" {
		t.Fatalf("labels = %v, want station/principal/grant", s.Labels)
	}
}

func TestLabelsOmitAnAbsentPrincipal(t *testing.T) {
	b, _ := RenderPolicy(baseEntry())
	if l := decodeStk(t, b)["forge-forgejo-aaa111"].Labels; len(l) != 2 || l["principal"] != "" {
		t.Fatalf("labels = %v", l)
	}
}

func TestSchemeAuthAndEnvVarFollowTheLedgerRulings(t *testing.T) {
	cases := []struct{ provider, mode, instance, scheme, auth, env, host string }{
		{"forgejo", "minted", "https://f.example.com", "token", "token", "FORGEJO_TOKEN", "f.example.com"},
		{"gitea", "supplied", "https://g.example.com", "token", "token", "GITEA_TOKEN", "g.example.com"},
		{"github", "supplied", "https://github.com", "bearer", "token", "GH_TOKEN", "api.github.com"},
		{"github", "app", "https://ghe.example.com", "bearer", "app", "GH_TOKEN", "ghe.example.com"},
		{"bitbucket", "supplied", "https://bitbucket.org", "bearer", "token", "BITBUCKET_TOKEN", "api.bitbucket.org"},
	}
	for _, c := range cases {
		e := baseEntry()
		e.Provider, e.Mode, e.Instance = c.provider, c.mode, c.instance
		b, err := RenderPolicy(e)
		if err != nil {
			t.Fatalf("%v: %v", c, err)
		}
		s := decodeStk(t, b)[e.Service]
		if s.Scheme != c.scheme || s.Auth != c.auth || s.EnvVar != c.env || s.Host != c.host {
			t.Errorf("%s/%s: got scheme=%s auth=%s env=%s host=%s", c.provider, c.mode, s.Scheme, s.Auth, s.EnvVar, s.Host)
		}
	}
}

func TestMergePolicyKeepsUnrelatedServicesAndUnknownTopLevelKeys(t *testing.T) {
	existing := `# top comment
workspace: demo
agent_uids: [1001, 1002]
notify:
  file: /var/log/stk-notify
custom_future_key:
  nested: [1, 2]
services:
  # keep this comment
  slack:
    capabilities:
      post: agent
  github:
    scopes: [repo]
profiles:
  reader:
    slack: [read]
`
	out, err := MergePolicy([]byte(existing), baseEntry())
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	_ = yaml.Unmarshal([]byte(existing), &before)
	if err := yaml.Unmarshal(out, &after); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"workspace", "agent_uids", "notify", "custom_future_key", "profiles"} {
		bb, _ := yaml.Marshal(before[k])
		ab, _ := yaml.Marshal(after[k])
		if !bytes.Equal(bb, ab) {
			t.Errorf("top-level %q changed:\n%s\n--\n%s", k, bb, ab)
		}
	}
	svcs := after["services"].(map[string]any)
	names := make([]string, 0)
	for n := range svcs {
		names = append(names, n)
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "forge-forgejo-aaa111,github,slack" {
		t.Fatalf("services = %v", names)
	}
	for _, c := range []string{"# top comment", "# keep this comment"} {
		if !strings.Contains(string(out), c) {
			t.Errorf("comment %q lost:\n%s", c, out)
		}
	}
	// A second merge of the same entry is a fixed point.
	again, err := MergePolicy(out, baseEntry())
	if err != nil || !bytes.Equal(out, again) {
		t.Fatalf("merge is not idempotent (err %v):\n%s\n--\n%s", err, out, again)
	}
}

func TestMergePolicyRejectsEveryBuiltinName(t *testing.T) {
	for _, name := range BuiltinServices {
		e := baseEntry()
		e.Service = name
		if _, err := MergePolicy(nil, e); !errors.Is(err, ErrReservedName) {
			t.Errorf("%s: err = %v, want ErrReservedName", name, err)
		}
	}
}

// The list is vendored from supertoolkit's catalog.builtin (commit 9fc1c19). If stk gains a
// service, this test is where to notice: update the list from `catalog.Names()` and this count.
func TestBuiltinServicesListMatchesTheRecordedStkCatalog(t *testing.T) {
	want := []string{"aws-sts", "cloudflare", "github", "github-app", "google", "notion", "openai", "resend", "slack", "stripe", "x"}
	got := append([]string(nil), BuiltinServices...)
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("BuiltinServices = %v, recorded stk catalog = %v", got, want)
	}
}

func TestMergePolicyRejectsMalformedEntries(t *testing.T) {
	mut := map[string]func(*PolicyEntry){
		"bad provider":      func(e *PolicyEntry) { e.Provider = "gitlab" },
		"bad mode":          func(e *PolicyEntry) { e.Mode = "magic" },
		"app on forgejo":    func(e *PolicyEntry) { e.Mode = "app" },
		"bad preset":        func(e *PolicyEntry) { e.Preset = "root" },
		"no repositories":   func(e *PolicyEntry) { e.Repositories = nil },
		"repo without name": func(e *PolicyEntry) { e.Repositories = []string{"acme"} },
		"repo three parts":  func(e *PolicyEntry) { e.Repositories = []string{"a/b/c"} },
		"repo with space":   func(e *PolicyEntry) { e.Repositories = []string{"a /b"} },
		"http instance":     func(e *PolicyEntry) { e.Instance = "http://forge.example.com" },
		"instance port":     func(e *PolicyEntry) { e.Instance = "https://forge.example.com:3000" },
		"instance path":     func(e *PolicyEntry) { e.Instance = "https://forge.example.com/forgejo" },
		"instance userinfo": func(e *PolicyEntry) { e.Instance = "https://u:p@forge.example.com" },
		"instance not url":  func(e *PolicyEntry) { e.Instance = "forge" },
		"name with space":   func(e *PolicyEntry) { e.Service = "a b" },
		"name with scope":   func(e *PolicyEntry) { e.Service = "a.scope-b" },
		"name dash first":   func(e *PolicyEntry) { e.Service = "-x" },
		"rule both":         func(e *PolicyEntry) { e.Rules = []Rule{{Allow: "a", Deny: "b"}} },
		"rule neither":      func(e *PolicyEntry) { e.Rules = []Rule{{}} },
		"no station":        func(e *PolicyEntry) { e.Station = "" },
		"no grant":          func(e *PolicyEntry) { e.Grant = "" },
		"control in label":  func(e *PolicyEntry) { e.Principal = "a\nb" },
		"long label":        func(e *PolicyEntry) { e.Station = strings.Repeat("x", 129) },
		"bad env var":       func(e *PolicyEntry) { e.EnvVar = "lower" },
	}
	for name, f := range mut {
		e := baseEntry()
		f(&e)
		if out, err := MergePolicy(nil, e); err == nil {
			t.Errorf("%s: accepted:\n%s", name, out)
		}
	}
}

func TestMergePolicyNeverOverwritesAnOperatorsEntryOrReusesAHost(t *testing.T) {
	op := "services:\n  forge-forgejo-aaa111:\n    kind: forge\n    provider: forgejo\n    host: mine.example.com\n    repositories: [a/b]\n"
	if _, err := MergePolicy([]byte(op), baseEntry()); !errors.Is(err, ErrConflict) {
		t.Errorf("operator's same-named entry: err = %v, want ErrConflict", err)
	}
	other := "services:\n  mine:\n    kind: forge\n    provider: forgejo\n    host: forge.example.com\n    repositories: [a/b]\n"
	if _, err := MergePolicy([]byte(other), baseEntry()); !errors.Is(err, ErrConflict) || !strings.Contains(err.Error(), "one service per host") {
		t.Errorf("host reuse: err = %v", err)
	}
	// The same grant under another name is refused too.
	e := baseEntry()
	e2 := baseEntry()
	e2.Service, e2.Instance = "forge-forgejo-zzz", "https://z.example.com"
	b, _ := MergePolicy(nil, e)
	if _, err := MergePolicy(b, e2); !errors.Is(err, ErrConflict) {
		t.Errorf("same grant, new name: err = %v", err)
	}
}

func TestMergePolicyRefusesAFileItCannotEditSafely(t *testing.T) {
	for _, in := range []string{"- a\n- b\n", "services: [1]\n", "a: [unclosed\n"} {
		if _, err := MergePolicy([]byte(in), baseEntry()); !errors.Is(err, ErrBadPolicyFile) {
			t.Errorf("%q: err = %v, want ErrBadPolicyFile", in, err)
		}
	}
	// Empty, comment-only and `services:` with no body are all fine.
	for _, in := range []string{"", "\n", "# nothing yet\n", "services:\n", "services: {}\n"} {
		if _, err := MergePolicy([]byte(in), baseEntry()); err != nil {
			t.Errorf("%q: %v", in, err)
		}
	}
}

func TestEnvVarCollisionFallsBackToGrantDerivedName(t *testing.T) {
	a := baseEntry()
	b := baseEntry()
	b.Service, b.Grant, b.Instance = "forge-forgejo-bbb", "fag_0123456789abcdef", "https://b.example.com"
	out, err := MergePolicy(nil, a)
	if err != nil {
		t.Fatal(err)
	}
	out, err = MergePolicy(out, b)
	if err != nil {
		t.Fatal(err)
	}
	if got := decodeStk(t, out)["forge-forgejo-bbb"].EnvVar; got != "AGENTPOD_FORGE_01234567_TOKEN" {
		t.Fatalf("env var = %q", got)
	}
}

func TestUpdateAndRemoveTouchOnlyManagedEntries(t *testing.T) {
	op := "services:\n  slack:\n    capabilities:\n      post: agent\n"
	out, _ := MergePolicy([]byte(op), baseEntry())
	if _, found, _ := UpdatePolicy(out, "stn_1", "fag_other", "read", nil, false); found {
		t.Error("found a grant that is not there")
	}
	if _, found, _ := UpdatePolicy(out, "stn_other", "fag_aaa111", "read", nil, false); found {
		t.Error("matched the wrong station")
	}
	rm, removed, err := RemoveEntries(out, map[string]bool{"fag_aaa111": true, "slack": true})
	if err != nil || len(removed) != 1 || removed[0] != "forge-forgejo-aaa111" {
		t.Fatalf("removed %v, %v", removed, err)
	}
	if !strings.Contains(string(rm), "slack:") {
		t.Fatal("operator's slack removed")
	}
}

func TestHostForTable(t *testing.T) {
	good := map[string]string{
		"https://Forge.Example.com":  "forge.example.com",
		"https://forge.example.com/": "forge.example.com",
	}
	for in, want := range good {
		if got, err := HostFor("forgejo", in); err != nil || got != want {
			t.Errorf("%s: %q, %v", in, got, err)
		}
	}
	if got, _ := HostFor("github", "https://api.github.com"); got != "api.github.com" {
		t.Errorf("api.github.com became %q", got)
	}
}
