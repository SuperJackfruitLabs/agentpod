package forgeapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// ---- a station's harness wiring, with no root and no systemd ----

// fakeToken stands for a real forge token. It is never given to any code under test except as
// the thing stk must NOT hand out; every assertion that it is absent looks for this string.
const fakeToken = "ghp_REALSECRETTOKEN0123456789abcdefghijkl"

type chownCall struct {
	path     string
	uid, gid int
}

type wiringFake struct {
	mu      sync.Mutex
	root    string
	running map[string]bool
	reloads int
	chowns  []chownCall
	unitEnv []string
	fchowns []chownCall
	extra   map[string]string // extra variables stk "reports" (a bad stk, a NO_PROXY ...)
	envErr  error
}

var wiringFakes sync.Map // *fixture -> *wiringFake

func (w *wiringFake) isRunning(unit string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.running[unit]
}

func (w *wiringFake) setRunning(unit string, v bool) {
	w.mu.Lock()
	w.running[unit] = v
	w.mu.Unlock()
}

func (w *wiringFake) chownsOf(path string) []chownCall {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []chownCall
	for _, c := range w.chowns {
		if c.path == path {
			out = append(out, c)
		}
	}
	return out
}

// Env is what `stk env --json` reports for an instance: ITS proxy (port and key are the
// instance's own) and a placeholder for every service in ITS policy file.
func (s *instStk) Env(context.Context) (stkclient.Env, error) {
	v, _ := wiringFakes.Load(s.fx)
	w, _ := v.(*wiringFake)
	if w != nil && w.envErr != nil {
		return stkclient.Env{}, w.envErr
	}
	proxy := fmt.Sprintf("http://stk:KEY-%s@127.0.0.1:%d", s.inst.Name, s.inst.Port)
	ca := filepath.Join(s.inst.StateDir, "ca.pem")
	vars := map[string]string{
		"HTTPS_PROXY": proxy, "https_proxy": proxy, "HTTP_PROXY": proxy, "http_proxy": proxy,
		"SSL_CERT_FILE": ca, "CURL_CA_BUNDLE": ca, "REQUESTS_CA_BUNDLE": ca, "NODE_EXTRA_CA_CERTS": ca,
		"NODE_USE_ENV_PROXY": "1", "STK_BROKERED": "1",
	}
	data, _, _ := readPolicyFile(s.inst.ConfigPath)
	var doc struct {
		Services map[string]struct {
			EnvVar string `yaml:"env_var"`
		} `yaml:"services"`
	}
	_ = yaml.Unmarshal(data, &doc)
	for name, svc := range doc.Services {
		if svc.EnvVar != "" {
			vars[svc.EnvVar] = "stk:ref:" + name + ":v1"
		}
	}
	if w != nil {
		for k, val := range w.extra {
			vars[k] = val
		}
	}
	return stkclient.Env{ProxyURL: vars["HTTPS_PROXY"], CAPath: ca, Vars: vars}, nil
}

func unitOf(key string) string {
	return "hermes-gateway-" + strings.TrimPrefix(key, "hermes:") + ".service"
}

// newWiringFixture is a fixture whose node wires harnesses.
func newWiringFixture(t *testing.T, mod ...func(*fixture, *InstancesConfig)) (*fixture, *wiringFake) {
	t.Helper()
	w := &wiringFake{running: map[string]bool{}, extra: map[string]string{}}
	var fxp *fixture
	mods := append([]func(*fixture, *InstancesConfig){func(fx *fixture, c *InstancesConfig) {
		fxp = fx
		w.root = fx.root
		wiringFakes.Store(fx, w)
		c.Harness = &HarnessWiring{
			Root: filepath.Join(fx.root, "harness-env"),
			Units: func(key string) []string {
				if strings.HasPrefix(key, "hermes:") {
					return []string{unitOf(key)}
				}
				return nil
			},
			DropInDir: func(unit string) string { return filepath.Join(fx.root, "dropins", unit+".d") },
			Running:   func(_ context.Context, unit string) bool { return w.isRunning(unit) },
			DaemonReload: func(context.Context) error {
				w.mu.Lock()
				w.reloads++
				w.mu.Unlock()
				return nil
			},
			Chown: func(path string, uid, gid int) error {
				w.mu.Lock()
				w.chowns = append(w.chowns, chownCall{path, uid, gid})
				w.mu.Unlock()
				return nil
			},
			FChown: func(f *os.File, uid, gid int) error {
				w.mu.Lock()
				w.fchowns = append(w.fchowns, chownCall{f.Name(), uid, gid})
				w.mu.Unlock()
				return nil
			},
			UnitEnv: func(context.Context, string) []string {
				w.mu.Lock()
				defer w.mu.Unlock()
				return append([]string(nil), w.unitEnv...)
			},
		}
	}}, mod...)
	fx := newFixture(t, mods...)
	t.Cleanup(func() { wiringFakes.Delete(fxp) })
	return fx, w
}

func (fx *fixture) deliverKeyed(station, grant, host string) (DeliverAck, error) {
	p := deliverParams(grant, host)
	p.StationID = station
	p.StationKey = "hermes:" + station
	p.Sealed = Sealed(HandoverPrefix + "SEALED-" + station + "-" + grant + "-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	return fx.m.Deliver(context.Background(), p)
}

func (fx *fixture) joinedLogs() string {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return strings.Join(fx.logs, "\n")
}

func (fx *fixture) envFile(station string) string {
	inst, _ := fx.m.Instance(station)
	return filepath.Join(fx.cfg.Harness.Root, inst.Name, unitOf("hermes:"+station)+".env")
}

func (fx *fixture) dropIn(station string) string {
	return filepath.Join(fx.cfg.Harness.DropInDir(unitOf("hermes:"+station)), dropInName)
}

func readOrEmpty(p string) string {
	b, _ := os.ReadFile(p)
	return string(b)
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

// ---- BrokerEnv ----

type envClient struct {
	stkclient.Client
	env stkclient.Env
	err error
}

func (c envClient) Env(context.Context) (stkclient.Env, error) { return c.env, c.err }

func goodVars() map[string]string {
	p := "http://stk:PROXYKEY@127.0.0.1:8901"
	return map[string]string{
		"HTTPS_PROXY": p, "https_proxy": p, "HTTP_PROXY": p, "http_proxy": p,
		"SSL_CERT_FILE": "/ca.pem", "CURL_CA_BUNDLE": "/ca.pem", "REQUESTS_CA_BUNDLE": "/ca.pem",
		"NODE_EXTRA_CA_CERTS": "/ca.pem", "NODE_USE_ENV_PROXY": "1", "STK_BROKERED": "1",
		"FORGEJO_TOKEN": "stk:ref:forge-forgejo-aaa111:v1",
	}
}

func TestBrokerEnvCarriesTheProxyCAAndPlaceholders(t *testing.T) {
	c := envClient{env: stkclient.Env{ProxyURL: "http://stk:PROXYKEY@127.0.0.1:8901", CAPath: "/ca.pem", Vars: goodVars()}}
	got, err := BrokerEnv(t.Context(), c, "stn_1")
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range goodVars() {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}

func TestBrokerEnvDropsRealSecretsAndNoProxy(t *testing.T) {
	v := goodVars()
	v["GH_TOKEN"] = fakeToken // a misbehaving stk, or a poisoned policy
	v["NO_PROXY"] = "forge.example.com"
	v["no_proxy"] = "forge.example.com"
	c := envClient{env: stkclient.Env{ProxyURL: "http://stk:PROXYKEY@127.0.0.1:8901", CAPath: "/ca.pem", Vars: v}}
	got, err := BrokerEnv(t.Context(), c, "stn_1")
	if err != nil {
		t.Fatal(err)
	}
	for k, val := range got {
		if strings.Contains(val, fakeToken) {
			t.Fatalf("%s carries a real secret", k)
		}
	}
	if _, ok := got["GH_TOKEN"]; ok {
		t.Error("a variable whose value is not a placeholder was passed on")
	}
	for _, k := range []string{"NO_PROXY", "no_proxy"} {
		if _, ok := got[k]; ok {
			t.Errorf("%s was passed on: a bypass the node must never create", k)
		}
	}
}

func TestBrokerEnvWithNoPlaceholdersIsEmptyAndNotAnError(t *testing.T) {
	v := goodVars()
	delete(v, "FORGEJO_TOKEN")
	c := envClient{env: stkclient.Env{ProxyURL: "http://stk:PROXYKEY@127.0.0.1:8901", CAPath: "/ca.pem", Vars: v}}
	got, err := BrokerEnv(t.Context(), c, "stn_1")
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v; want an empty map: a station with no grants keeps its environment", got, err)
	}
}

func TestBrokerEnvErrorsNameNoSecret(t *testing.T) {
	c := envClient{err: errors.New("stk env: exit 1: the listener is not a running stk proxy")}
	_, err := BrokerEnv(t.Context(), c, "stn_1")
	if err == nil || !strings.HasPrefix(err.Error(), "broker-env-failed:") {
		t.Fatalf("err = %v", err)
	}
	if _, err := BrokerEnv(t.Context(), envClient{}, " "); err == nil || !strings.HasPrefix(err.Error(), "invalid-params:") {
		t.Fatalf("an empty station id: %v", err)
	}
}

// ---- WithBrokerEnv ----

func captureEnvLogs(t *testing.T) *[]string {
	t.Helper()
	var mu sync.Mutex
	var lines []string
	old := logf
	logf = func(f string, a ...any) {
		mu.Lock()
		lines = append(lines, fmt.Sprintf(f, a...))
		mu.Unlock()
	}
	resetNoProxyWarned()
	oldLookup := lookupProcessEnv
	lookupProcessEnv = func(string) string { return "" }
	t.Cleanup(func() { logf = old; lookupProcessEnv = oldLookup; resetNoProxyWarned() })
	return &lines
}

func TestWithBrokerEnvDescriptorValuesWinOnlyWhenTheySetTheSameName(t *testing.T) {
	captureEnvLogs(t)
	env := []string{"FOO=1", "SSL_CERT_FILE=/descriptor.pem"}
	add := map[string]string{"HTTPS_PROXY": "http://stk:K@127.0.0.1:1", "SSL_CERT_FILE": "/ca.pem"}
	got := WithBrokerEnv(env, add)
	want := map[string]string{"FOO": "1", "SSL_CERT_FILE": "/descriptor.pem", "HTTPS_PROXY": "http://stk:K@127.0.0.1:1"}
	m := map[string]string{}
	for _, e := range got {
		k, v, _ := strings.Cut(e, "=")
		if _, dup := m[k]; dup {
			t.Fatalf("%s is set twice: %v", k, got)
		}
		m[k] = v
	}
	if fmt.Sprint(m) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", m, want)
	}
	if len(env) != 2 {
		t.Error("the caller's slice was modified")
	}
}

func TestWithBrokerEnvLeavesAStationWithoutGrantsExactlyAsItWas(t *testing.T) {
	captureEnvLogs(t)
	env := []string{"FOO=1"}
	if got := WithBrokerEnv(env, nil); fmt.Sprint(got) != fmt.Sprint(env) {
		t.Fatalf("got %v", got)
	}
	if got := WithBrokerEnv(nil, map[string]string{}); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

func TestTheNodeNeverSetsNoProxy(t *testing.T) {
	captureEnvLogs(t)
	got := WithBrokerEnv([]string{"FOO=1"}, map[string]string{"NO_PROXY": "x", "no_proxy": "y", "HTTPS_PROXY": "p"})
	for _, e := range got {
		if strings.HasPrefix(strings.ToLower(e), "no_proxy=") {
			t.Fatalf("NO_PROXY was added: %v", got)
		}
	}
}

func TestANoProxyThatCoversTheForgeHostIsWarnedAboutOnce(t *testing.T) {
	lines := captureEnvLogs(t)
	add := map[string]string{"HTTPS_PROXY": "http://stk:SECRETKEY@127.0.0.1:1"}
	env := []string{"NO_PROXY=localhost,.example.com"}
	for i := 0; i < 3; i++ {
		got := WithBrokerEnv(env, add, "forge.example.com")
		if !contains(got, "NO_PROXY=localhost,.example.com") {
			t.Fatalf("the descriptor's NO_PROXY was changed: %v", got)
		}
	}
	n := 0
	for _, l := range *lines {
		if strings.Contains(l, "WARNING") && strings.Contains(l, "NO_PROXY") && strings.Contains(l, "forge.example.com") {
			n++
		}
		if strings.Contains(l, "SECRETKEY") {
			t.Errorf("the proxy credential was logged: %q", l)
		}
	}
	if n != 1 {
		t.Fatalf("warnings = %d, want exactly 1 (%v)", n, *lines)
	}
}

func TestNoProxyCoverage(t *testing.T) {
	cases := []struct {
		np, host string
		want     bool
	}{
		{"*", "forge.example.com", true},
		{"forge.example.com", "forge.example.com", true},
		{".example.com", "forge.example.com", true},
		{"example.com", "forge.example.com", true},
		{"*.example.com", "forge.example.com", true},
		{"FORGE.example.com:443", "forge.example.com", true},
		{"localhost,127.0.0.1", "forge.example.com", false},
		{"other.com", "forge.example.com", false},
		{"notexample.com", "forge.example.com", false},
		{"", "forge.example.com", false},
	}
	for _, c := range cases {
		if got := noProxyCovers(c.np, c.host); got != c.want {
			t.Errorf("noProxyCovers(%q, %q) = %v, want %v", c.np, c.host, got, c.want)
		}
	}
}

func TestANoProxyInTheNodesOwnEnvironmentIsWarnedAboutToo(t *testing.T) {
	lines := captureEnvLogs(t)
	lookupProcessEnv = func(k string) string {
		if k == "no_proxy" {
			return "*"
		}
		return ""
	}
	WithBrokerEnv(nil, map[string]string{"HTTPS_PROXY": "p"}, "forge.example.com")
	if len(*lines) != 1 || !strings.Contains((*lines)[0], "WARNING") {
		t.Fatalf("lines = %v", *lines)
	}
}

func TestANoProxyThatDoesNotCoverTheForgeIsNotWarnedAbout(t *testing.T) {
	lines := captureEnvLogs(t)
	WithBrokerEnv([]string{"NO_PROXY=localhost"}, map[string]string{"HTTPS_PROXY": "p"}, "forge.example.com")
	if len(*lines) != 0 {
		t.Fatalf("lines = %v", *lines)
	}
}

func TestWithBrokerCommandAddsTheStationsEnvBesideTheDescriptors(t *testing.T) {
	captureEnvLogs(t)
	inner := func(key string) ([]string, string, []string, error) {
		return []string{"agent"}, "/work", []string{"FOO=1", "SSL_CERT_FILE=/descriptor.pem"}, nil
	}
	lookup := func(key string) (map[string]string, []string) {
		if key == "hermes:press" {
			return map[string]string{"HTTPS_PROXY": "http://p", "SSL_CERT_FILE": "/ca.pem"}, nil
		}
		return nil, nil
	}
	argv, dir, env, err := WithBrokerCommand(inner, lookup)("hermes:press")
	if err != nil || len(argv) != 1 || dir != "/work" {
		t.Fatalf("%v %v %v", argv, dir, err)
	}
	if !contains(env, "HTTPS_PROXY=http://p") || !contains(env, "SSL_CERT_FILE=/descriptor.pem") || contains(env, "SSL_CERT_FILE=/ca.pem") {
		t.Fatalf("env = %v", env)
	}
	_, _, env, _ = WithBrokerCommand(inner, lookup)("hermes:other")
	if fmt.Sprint(env) != "[FOO=1 SSL_CERT_FILE=/descriptor.pem]" {
		t.Fatalf("a station with no grants must be unchanged: %v", env)
	}
	wantErr := errors.New("boom")
	_, _, _, err = WithBrokerCommand(func(string) ([]string, string, []string, error) { return nil, "", nil, wantErr }, lookup)("x")
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v", err)
	}
}

func TestEnvListIsSortedAndComplete(t *testing.T) {
	got := EnvList(map[string]string{"B": "2", "A": "1"})
	if fmt.Sprint(got) != "[A=1 B=2]" {
		t.Fatal(got)
	}
}

// ---- per-station env for a spawn ----

func TestASpawnGetsOnlyItsOwnStationsProxyCAAndPlaceholders(t *testing.T) {
	fx, _ := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.deliverKeyed("stn_2", "fag_bbb222", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	i1, _ := fx.m.Instance("stn_1")
	i2, _ := fx.m.Instance("stn_2")

	env1, hosts := fx.m.EnvForKey("hermes:stn_1")
	env2, _ := fx.m.EnvForKey("hermes:stn_2")
	if len(env1) == 0 || len(env2) == 0 {
		t.Fatalf("env1=%v env2=%v", env1, env2)
	}
	if len(hosts) != 1 || hosts[0] != "forge.example.com" {
		t.Errorf("hosts = %v", hosts)
	}
	if !strings.Contains(env1["HTTPS_PROXY"], fmt.Sprintf("127.0.0.1:%d", i1.Port)) || !strings.Contains(env1["HTTPS_PROXY"], "KEY-"+i1.Name) {
		t.Errorf("station 1 proxy = %q", env1["HTTPS_PROXY"])
	}
	if env1["HTTPS_PROXY"] == env2["HTTPS_PROXY"] {
		t.Fatal("two stations got the same proxy URL")
	}
	if env1["NODE_EXTRA_CA_CERTS"] == "" || env1["SSL_CERT_FILE"] == "" || env1["HTTP_PROXY"] == "" {
		t.Errorf("proxy and CA variables missing: %v", env1)
	}
	if env1["FORGEJO_TOKEN"] != "stk:ref:forge-forgejo-aaa111:v1" || env2["FORGEJO_TOKEN"] != "stk:ref:forge-forgejo-bbb222:v1" {
		t.Errorf("placeholders: %q / %q", env1["FORGEJO_TOKEN"], env2["FORGEJO_TOKEN"])
	}
	// nothing of the other station
	for k, v := range env1 {
		for _, other := range []string{"KEY-" + i2.Name, fmt.Sprintf(":%d", i2.Port), "bbb222", i2.Name} {
			if strings.Contains(v, other) {
				t.Errorf("station 1's %s carries station 2's %q", k, other)
			}
		}
	}
	for k, v := range env2 {
		for _, other := range []string{"KEY-" + i1.Name, fmt.Sprintf(":%d", i1.Port), "aaa111", i1.Name} {
			if strings.Contains(v, other) {
				t.Errorf("station 2's %s carries station 1's %q", k, other)
			}
		}
	}
}

func TestASpawnNeverGetsAServiceSecretOrNoProxy(t *testing.T) {
	fx, w := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.extra["GH_TOKEN"] = fakeToken
	w.extra["NO_PROXY"] = "forge.example.com"
	w.mu.Unlock()
	env, _ := fx.m.EnvForKey("hermes:stn_1")
	for k, v := range env {
		if strings.Contains(v, fakeToken) || k == "GH_TOKEN" {
			t.Errorf("%s carries a real secret", k)
		}
		if strings.EqualFold(k, "no_proxy") {
			t.Errorf("%s set", k)
		}
	}
	if len(env) == 0 {
		t.Fatal("no env")
	}
}

func TestAStationWithoutGrantsSpawnsUnchanged(t *testing.T) {
	fx, _ := newWiringFixture(t)
	if err := os.MkdirAll(filepath.Dir(fx.cfg.SharedPolicyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fx.cfg.SharedPolicyPath, []byte(sharedBase), 0o644); err != nil {
		t.Fatal(err)
	}
	// status creates the instance (the hub fetches the key before the first grant) ...
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	// ... and a shared base service does not make it a forge station
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(fx.policyOf("stn_1")), "shared:slack") {
		t.Fatal("the fixture lost its shared base service")
	}
	if env, _ := fx.m.EnvForKey("hermes:stn_1"); env != nil {
		t.Fatalf("a station with no grants of its own got %v", env)
	}
	if exists(fx.envFile("stn_1")) {
		t.Fatal("a drop-in was written for a station with no grants of its own")
	}
	if env, _ := fx.m.EnvForKey("hermes:never-seen"); env != nil {
		t.Fatalf("a station with no instance got %v", env)
	}
}

func TestWithoutHarnessWiringNothingIsRecordedOrWired(t *testing.T) {
	fx := newFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if env, _ := fx.m.EnvForKey("hermes:stn_1"); env != nil {
		t.Fatalf("env = %v", env)
	}
	if b, _ := os.ReadFile(fx.cfg.RegistryPath); strings.Contains(string(b), "hermes:stn_1") {
		t.Error("the station key was recorded though wiring is off")
	}
}

func TestASpawnWhoseStkReportsAnotherInstancesProxyIsRefused(t *testing.T) {
	fx, w := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	i1, _ := fx.m.Instance("stn_1")
	other := fmt.Sprintf("http://stk:OTHERKEY@127.0.0.1:%d", i1.Port+1)
	w.mu.Lock()
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		w.extra[k] = other
	}
	w.mu.Unlock()
	if env, _ := fx.m.EnvForKey("hermes:stn_1"); env != nil {
		t.Fatalf("a proxy that is not this station's instance was handed to its harness: %v", env)
	}
	if strings.Contains(fx.joinedLogs(), "OTHERKEY") {
		t.Error("a proxy credential was logged")
	}
}

func TestAnStkFailureAtSpawnIsLoggedWithoutAnySecretAndSpawnsUnchanged(t *testing.T) {
	fx, w := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.envErr = errors.New("stk env: the listener is not a running stk proxy")
	w.mu.Unlock()
	if env, _ := fx.m.EnvForKey("hermes:stn_1"); env != nil {
		t.Fatalf("env = %v", env)
	}
	if !strings.Contains(fx.joinedLogs(), "not a running stk proxy") {
		t.Error("the failure was not logged")
	}
}

// ---- systemd-started harnesses ----

func TestASystemdHarnessGetsA0600DropInOwnedByTheStationsAgentUID(t *testing.T) {
	fx, w := newWiringFixture(t)
	ack, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err != nil || !ack.OK {
		t.Fatalf("%+v %v", ack, err)
	}
	f := fx.envFile("stn_1")
	st, err := os.Stat(f)
	if err != nil {
		t.Fatalf("no env file: %v", err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", st.Mode().Perm())
	}
	uid := uidFor("stn_1")[0]
	// owner is set on the open temp file BEFORE content is written, never on the final path
	// (which an agent could have replaced with a symlink)
	w.mu.Lock()
	fc := append([]chownCall(nil), w.fchowns...)
	w.mu.Unlock()
	if len(fc) == 0 || fc[len(fc)-1].uid != uid || filepath.Dir(fc[len(fc)-1].path) != filepath.Dir(f) || !strings.HasPrefix(filepath.Base(fc[len(fc)-1].path), ".env-") {
		t.Errorf("fchown calls = %+v, want the temp file in %s owned by uid %d", fc, filepath.Dir(f), uid)
	}
	if len(w.chownsOf(f)) != 0 {
		t.Error("the final path was chowned by path: a symlink there would be followed")
	}
	dir := filepath.Dir(f)
	if dst, _ := os.Stat(dir); dst.Mode().Perm() != 0o700 {
		t.Errorf("the env file's directory is %v, want 0700", dst.Mode().Perm())
	}
	if c := w.chownsOf(dir); len(c) == 0 || c[len(c)-1].uid != uid {
		t.Errorf("chown calls on the directory = %+v", c)
	}
	body := readOrEmpty(f)
	i1, _ := fx.m.Instance("stn_1")
	for _, want := range []string{
		fmt.Sprintf("HTTPS_PROXY=\"http://stk:KEY-%s@127.0.0.1:%d\"", i1.Name, i1.Port),
		"NODE_EXTRA_CA_CERTS=", "FORGEJO_TOKEN=\"stk:ref:forge-forgejo-aaa111:v1\"",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("env file lacks %s:\n%s", want, body)
		}
	}
	if strings.Contains(strings.ToLower(body), "no_proxy") || strings.Contains(body, "SEALED") {
		t.Errorf("env file:\n%s", body)
	}
	// the unit reads it, and the file holds the only copy of the credential
	conf := readOrEmpty(fx.dropIn("stn_1"))
	if !strings.Contains(conf, "[Service]") || !strings.Contains(conf, "EnvironmentFile=-"+f) {
		t.Errorf("drop-in:\n%s", conf)
	}
	if strings.Contains(conf, "KEY-") {
		t.Error("the drop-in unit file carries the proxy credential")
	}
	if w.reloads == 0 {
		t.Error("systemd was not told to reload")
	}
}

func TestEachStationsDropInHoldsOnlyItsOwnProxy(t *testing.T) {
	fx, _ := newWiringFixture(t)
	for _, s := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliverKeyed(s, "fag_"+s, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	i1, _ := fx.m.Instance("stn_1")
	i2, _ := fx.m.Instance("stn_2")
	b1, b2 := readOrEmpty(fx.envFile("stn_1")), readOrEmpty(fx.envFile("stn_2"))
	if !strings.Contains(b1, "KEY-"+i1.Name) || strings.Contains(b1, i2.Name) || strings.Contains(b1, fmt.Sprintf(":%d", i2.Port)) {
		t.Errorf("station 1 file:\n%s", b1)
	}
	if !strings.Contains(b2, "KEY-"+i2.Name) || strings.Contains(b2, i1.Name) || strings.Contains(b2, fmt.Sprintf(":%d", i1.Port)) {
		t.Errorf("station 2 file:\n%s", b2)
	}
}

func TestADeliverToARunningHarnessSaysItNeedsARestart(t *testing.T) {
	fx, w := newWiringFixture(t)
	w.setRunning(unitOf("hermes:stn_1"), true)
	ack, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err != nil || !ack.NeedsRestart {
		t.Fatalf("ack = %+v %v, want needsRestart", ack, err)
	}
	// the same delivery again changes nothing, so there is nothing new for the process to pick up
	ack, err = fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err != nil || ack.NeedsRestart {
		t.Fatalf("a replay: %+v %v", ack, err)
	}
	// a second grant adds a placeholder: the running process needs a restart again
	ack, err = fx.deliverKeyed("stn_1", "fag_ccc333", "other.example.com")
	if err != nil || !ack.NeedsRestart {
		t.Fatalf("a new grant: %+v %v", ack, err)
	}
}

func TestADeliverToAHarnessThatIsNotRunningNeedsNoRestart(t *testing.T) {
	fx, _ := newWiringFixture(t)
	ack, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err != nil || !ack.OK || ack.NeedsRestart {
		t.Fatalf("ack = %+v %v", ack, err)
	}
}

func TestRevokeRemovesTheEnvEntriesAndTheDropInAndSaysARunningHarnessNeedsARestart(t *testing.T) {
	fx, w := newWiringFixture(t)
	for _, g := range []struct{ id, host string }{{"fag_aaa111", "forge.example.com"}, {"fag_ccc333", "other.example.com"}} {
		if _, err := fx.deliverKeyed("stn_1", g.id, g.host); err != nil {
			t.Fatal(err)
		}
	}
	w.setRunning(unitOf("hermes:stn_1"), true)
	// one grant goes: its placeholder leaves the file, the other stays
	ack, err := fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"})
	if err != nil || !ack.Removed || !ack.NeedsRestart {
		t.Fatalf("ack = %+v %v", ack, err)
	}
	body := readOrEmpty(fx.envFile("stn_1"))
	if strings.Contains(body, "aaa111") || !strings.Contains(body, "ccc333") {
		t.Errorf("after revoking one of two:\n%s", body)
	}
	// the last grant goes: no env file, no drop-in
	ack, err = fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_ccc333"})
	if err != nil || !ack.Removed || !ack.NeedsRestart {
		t.Fatalf("ack = %+v %v", ack, err)
	}
	if exists(fx.envFile("stn_1")) || exists(fx.dropIn("stn_1")) {
		t.Error("the env file or drop-in survived the last revoke")
	}
	if env, _ := fx.m.EnvForKey("hermes:stn_1"); env != nil {
		t.Errorf("a spawn after the last revoke still got %v", env)
	}
	// idempotent, and nothing to restart when there was nothing to remove
	ack, err = fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_ccc333"})
	if err != nil || ack.Removed || ack.NeedsRestart {
		t.Fatalf("a repeat: %+v %v", ack, err)
	}
}

func TestRevokeOfAStoppedHarnessNeedsNoRestart(t *testing.T) {
	fx, _ := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	ack, err := fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"})
	if err != nil || !ack.Removed || ack.NeedsRestart {
		t.Fatalf("ack = %+v %v", ack, err)
	}
}

func TestRevokingOneStationLeavesTheOthersDropInAlone(t *testing.T) {
	fx, _ := newWiringFixture(t)
	for _, s := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliverKeyed(s, "fag_"+s, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	before := readOrEmpty(fx.envFile("stn_2"))
	if _, err := fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_stn_1"}); err != nil {
		t.Fatal(err)
	}
	if exists(fx.envFile("stn_1")) || !exists(fx.envFile("stn_2")) || readOrEmpty(fx.envFile("stn_2")) != before || !exists(fx.dropIn("stn_2")) {
		t.Error("station 2's wiring changed with station 1's revoke")
	}
}

func TestAHarnessUIDThatIsTheNodesOwnRootUIDIsRefusedUnlessAcknowledged(t *testing.T) {
	fx, w := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) { c.AgentUIDs = func(string) []int { return []int{0} } })
	_, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err == nil || !strings.HasPrefix(err.Error(), "harness-uid-is-node:") {
		t.Fatalf("err = %v", err)
	}
	if exists(fx.envFile("stn_1")) || len(w.chowns) != 0 || len(w.fchowns) != 0 {
		t.Error("a drop-in was written for a harness that shares the node's uid")
	}

	fx2, w2 := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) {
		c.AgentUIDs = func(string) []int { return []int{0} }
		c.AllowSharedAgentUID = true
	})
	if _, err := fx2.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatalf("acknowledged: %v", err)
	}
	if !exists(fx2.envFile("stn_1")) || len(w2.fchowns) == 0 {
		t.Error("an acknowledged shared uid must still get its drop-in")
	}
}

func TestADeliverWhoseEnvCannotBeReadFailsLoudlyWithoutASecret(t *testing.T) {
	fx, w := newWiringFixture(t)
	w.mu.Lock()
	w.envErr = errors.New("stk env: no fixed proxy is running")
	w.mu.Unlock()
	_, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err == nil || !strings.HasPrefix(err.Error(), "harness-wiring-failed:") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), "KEY-") || strings.Contains(fx.joinedLogs(), "KEY-") {
		t.Error("a proxy credential leaked into an error or a log")
	}
	if exists(fx.envFile("stn_1")) {
		t.Error("an env file was written")
	}
}

func TestTheProxyCredentialIsInTheEnvFileAndNowhereElse(t *testing.T) {
	fx, _ := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	i1, _ := fx.m.Instance("stn_1")
	key := "KEY-" + i1.Name
	if !strings.Contains(readOrEmpty(fx.envFile("stn_1")), key) {
		t.Fatal("the env file lacks the credential")
	}
	if strings.Contains(fx.joinedLogs(), key) {
		t.Error("logged")
	}
	for _, p := range []string{fx.cfg.RegistryPath, fx.dropIn("stn_1"), i1.ConfigPath} {
		if strings.Contains(readOrEmpty(p), key) {
			t.Errorf("%s carries the credential", p)
		}
	}
	ack, _ := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if strings.Contains(fmt.Sprintf("%+v", ack), key) {
		t.Error("in an ack")
	}
}

func TestPruningAnInstanceRemovesItsWiring(t *testing.T) {
	fx, _ := newWiringFixture(t)
	for _, s := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliverKeyed(s, "fag_"+s, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	f1, f2 := fx.envFile("stn_1"), fx.envFile("stn_2")
	if _, err := fx.m.PruneUnhosted(context.Background(), []string{"stn_2"}); err != nil {
		t.Fatal(err)
	}
	if exists(f1) || exists(fx.dropIn("stn_1")) || exists(filepath.Dir(f1)) {
		t.Error("the pruned station's wiring survived")
	}
	if !exists(f2) || !exists(fx.dropIn("stn_2")) {
		t.Error("the hosted station's wiring was removed")
	}
}

func TestOnlyTheNodesOwnFilesAreRemovedFromTheWiringDirectory(t *testing.T) {
	fx, _ := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	stray := filepath.Join(filepath.Dir(fx.envFile("stn_1")), "operator-notes.txt")
	if err := os.WriteFile(stray, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"}); err != nil {
		t.Fatal(err)
	}
	if !exists(stray) {
		t.Error("a file the node did not write was removed")
	}
}

func TestAHarnessWithNoSystemdUnitGetsNoDropIn(t *testing.T) {
	fx, w := newWiringFixture(t)
	p := deliverParams("fag_aaa111", "forge.example.com")
	p.StationID, p.StationKey = "stn_1", "claude-code:work"
	p.Sealed = Sealed(HandoverPrefix + "SEALED-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if _, err := fx.m.Deliver(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Join(fx.root, "harness-env")); len(w.chowns) != 0 || len(entries) > 1 {
		t.Errorf("wiring written for a harness no unit starts: %v %v", entries, w.chowns)
	}
	if inst, ok := fx.m.Instance("stn_1"); ok {
		if entries, _ := os.ReadDir(filepath.Join(fx.root, "harness-env", inst.Name)); len(entries) != 0 {
			t.Errorf("env files for a harness no unit starts: %v", entries)
		}
	}
	if env, _ := fx.m.EnvForKey("claude-code:work"); env == nil {
		t.Error("an ACP-spawned harness must still get its env at spawn")
	}
}

func TestTheStationKeyIsRecordedWithoutASecret(t *testing.T) {
	fx, _ := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	recs, err := fx.m.readRecords()
	if err != nil || recs["stn_1"].StationKey != "hermes:stn_1" {
		t.Fatalf("%+v %v", recs, err)
	}
	units := []string{}
	for _, e := range func() []os.DirEntry { d, _ := os.ReadDir(filepath.Dir(fx.envFile("stn_1"))); return d }() {
		units = append(units, e.Name())
	}
	sort.Strings(units)
	if fmt.Sprint(units) != "["+unitOf("hermes:stn_1")+".env]" {
		t.Errorf("wiring directory = %v", units)
	}
}

func TestNeedsRestartIsInTheAckOnlyWhenSet(t *testing.T) {
	for _, c := range []struct {
		v    any
		want string
	}{
		{DeliverAck{OK: true, Stored: true, Isolation: "separate-user", NeedsRestart: true}, `"needsRestart":true`},
		{RevokeAck{Removed: true, NeedsRestart: true}, `"needsRestart":true`},
	} {
		b, _ := json.Marshal(c.v)
		if !strings.Contains(string(b), c.want) {
			t.Errorf("%s lacks %s", b, c.want)
		}
	}
	b, _ := json.Marshal(DeliverAck{OK: true, Stored: true, Isolation: "separate-user"})
	if strings.Contains(string(b), "needsRestart") {
		t.Errorf("an unchanged ack carries needsRestart: %s", b)
	}
}
