package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

func runForgeAPI(t *testing.T, args []string, res forgeapi.SetupResult, err error) (code int, out, errOut string, got forgeapi.SetupOptions) {
	t.Helper()
	var o, e bytes.Buffer
	d := forgeAPIDeps{
		newClient: func(string, string, string) stkclient.Client { return nil },
		setup: func(_ context.Context, _ func() stkclient.Client, so forgeapi.SetupOptions) (forgeapi.SetupResult, error) {
			got = so
			return res, err
		},
	}
	code = forgeAPICmdWith(args, &o, &e, d)
	return code, o.String(), e.String(), got
}

func sepReport() stkclient.DoctorReport {
	return stkclient.DoctorReport{Isolation: stkclient.Isolation{Level: "separate-user", Method: "mode-bits", Reasons: []string{"store owned by stk"}}}
}

func TestForgeAPISetupParsesFlagsAndReportsSeparateUser(t *testing.T) {
	code, out, _, got := runForgeAPI(t, []string{"setup", "--user", "stkx", "--agent-uid", "1001", "--agent-uid=1002", "--state-dir", "/srv/stk"},
		forgeapi.SetupResult{Report: sepReport(), Installed: true}, nil)
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got.ServiceUser != "stkx" || len(got.AgentUIDs) != 2 || got.AgentUIDs[1] != 1002 || got.StateDir != "/srv/stk" {
		t.Fatalf("opts = %+v", got)
	}
	for _, want := range []string{"isolation: separate-user", "method:    mode-bits", "reason:    store owned by stk"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestForgeAPISetupSameUserIsExitZeroAndLabelledDegraded(t *testing.T) {
	r := forgeapi.SetupResult{Report: stkclient.DoctorReport{Isolation: stkclient.Isolation{Level: "same-user"}}, Degraded: true, Reason: "not running as root; run `sudo agentpod-node forge-api setup`"}
	code, out, _, _ := runForgeAPI(t, []string{"setup"}, r, nil)
	if code != 0 || !strings.Contains(out, "same-user (DEGRADED)") || !strings.Contains(out, "sudo agentpod-node forge-api setup") {
		t.Fatalf("code=%d out=%s", code, out)
	}
}

func TestForgeAPISetupErrorsExitNonZero(t *testing.T) {
	code, _, errOut, _ := runForgeAPI(t, []string{"setup"}, forgeapi.SetupResult{}, errors.New("boom"))
	if code != 1 || !strings.Contains(errOut, "boom") {
		t.Fatalf("code=%d err=%s", code, errOut)
	}
	if code, _, _, _ := runForgeAPI(t, []string{"setup", "--agent-uid", "x"}, forgeapi.SetupResult{}, nil); code != 2 {
		t.Fatalf("bad flag code = %d, want 2", code)
	}
	if code, _, _, _ := runForgeAPI(t, []string{"nope"}, forgeapi.SetupResult{}, nil); code != 2 {
		t.Fatalf("unknown verb code = %d, want 2", code)
	}
}

func TestForgeAPIIsRegisteredInHelp(t *testing.T) {
	if !isCommand("forge-api") || commandHelp("forge-api") == "" {
		t.Fatal("forge-api must be in the commands registry")
	}
}

func TestStkOptionsStateDirReachesTheClientEnv(t *testing.T) {
	yes := func(string) bool { return true }
	no := func(string) bool { return false }
	if o := stkOptions(0, no, "stk", "/srv/stk"); o.Env["STK_HOME"] != "/srv/stk" || o.RunAs != "" {
		t.Fatalf("explicit state dir before the user exists: %+v", o)
	}
	if o := stkOptions(0, yes, "stk", "/srv/stk"); o.Env["STK_HOME"] != "/srv/stk" || o.RunAs != "stk" {
		t.Fatalf("explicit state dir after install: %+v", o)
	}
	if o := stkOptions(0, yes, "stk", ""); o.Env["STK_HOME"] != "/var/lib/stk" || o.RunAs != "stk" {
		t.Fatalf("default service dir: %+v", o)
	}
	if o := stkOptions(1000, yes, "stk", ""); o.RunAs != "" || len(o.Env) != 0 {
		t.Fatalf("a non-root node uses its own stk home: %+v", o)
	}
	if o := stkOptions(0, no, "stk", ""); o.RunAs != "" || len(o.Env) != 0 {
		t.Fatalf("root before install: %+v", o)
	}
}

func TestAgentUIDRejectsOutOfRange(t *testing.T) {
	for _, bad := range []string{"4294967296", "-1", "x", ""} {
		var u uidList
		if u.Set(bad) == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	var u uidList
	if err := u.Set("4294967295"); err != nil || u[0] != 4294967295 {
		t.Fatalf("max uid: %v %v", err, u)
	}
}

// ---- one stk instance per station ----

func testInstance() forgeapi.Instance {
	return forgeapi.Instance{Station: "stn_1", Name: "stk-stn-1-abcdef", Port: 8900,
		StateDir: "/var/lib/stk-stn-1-abcdef", RuntimeDir: "/run/stk-stn-1-abcdef", ConfigPath: "/etc/stk-stn-1-abcdef/supertoolkit.yaml"}
}

func TestInstanceClientRunsAsTheInstanceUserWithItsOwnStore(t *testing.T) {
	inst := testInstance()
	o := instanceClientOptions(0, func(string) bool { return true }, inst)
	if o.RunAs != inst.Name || o.Env["STK_HOME"] != inst.StateDir || o.Env["STK_CONFIG"] != inst.ConfigPath || o.Env["STK_SOCKET"] != "/run/stk-stn-1-abcdef/stk.sock" {
		t.Fatalf("options = %+v", o)
	}
	// before the user exists, and without root, nothing is bound to the instance
	if o := instanceClientOptions(0, func(string) bool { return false }, inst); o.RunAs != "" || len(o.Env) != 0 {
		t.Fatalf("before install: %+v", o)
	}
	if o := instanceClientOptions(1000, func(string) bool { return true }, inst); o.RunAs != "" || len(o.Env) != 0 {
		t.Fatalf("non-root: %+v", o)
	}
}

func TestForgeAPIInstancesConfigPrefersEnvironmentOverConfig(t *testing.T) {
	c := config.ForgeAPI{SharedPolicy: "/etc/a.yaml", ProxyPortMin: 9000, ProxyPortMax: 9010, Registry: "/var/r.json"}
	cfg, err := forgeAPIInstancesConfig(c, func(string) string { return "" })
	if err != nil || cfg.SharedPolicyPath != "/etc/a.yaml" || cfg.PortMin != 9000 || cfg.PortMax != 9010 || cfg.RegistryPath != "/var/r.json" {
		t.Fatalf("config only: %+v %v", cfg, err)
	}
	env := map[string]string{"AGENTPOD_STK_SHARED_POLICY": "/etc/b.yaml", "AGENTPOD_STK_PORTS": "9100-9199", "AGENTPOD_STK_REGISTRY": "/var/x.json"}
	cfg, err = forgeAPIInstancesConfig(c, func(k string) string { return env[k] })
	if err != nil || cfg.SharedPolicyPath != "/etc/b.yaml" || cfg.PortMin != 9100 || cfg.PortMax != 9199 || cfg.RegistryPath != "/var/x.json" {
		t.Fatalf("env: %+v %v", cfg, err)
	}
	// defaults stay empty here: the manager fills them
	cfg, err = forgeAPIInstancesConfig(config.ForgeAPI{}, func(string) string { return "" })
	if err != nil || cfg.PortMin != 0 || cfg.SharedPolicyPath != "" {
		t.Fatalf("defaults: %+v %v", cfg, err)
	}
	for _, bad := range []string{"8900", "a-b", "9000-8900x", "-5"} {
		if _, err := forgeAPIInstancesConfig(c, func(k string) string {
			if k == "AGENTPOD_STK_PORTS" {
				return bad
			}
			return ""
		}); err == nil {
			t.Errorf("AGENTPOD_STK_PORTS=%q accepted", bad)
		}
	}
	// the range itself is validated when the manager is made
	if _, err := newStationInstances(config.Config{ForgeAPI: &config.ForgeAPI{ProxyPortMin: 9000, ProxyPortMax: 8000}}, func(string) string { return "" }); err == nil {
		t.Error("an inverted range was accepted")
	}
}

func TestForgeAPISetupStationDerivesEverythingAndReportsTheInstance(t *testing.T) {
	var gotID string
	var gotUIDs []int
	var o, e bytes.Buffer
	d := forgeAPIDeps{station: func(_ context.Context, id string, uids []int, _ bool) (forgeapi.SetupResult, forgeapi.Instance, error) {
		gotID, gotUIDs = id, uids
		return forgeapi.SetupResult{Report: sepReport(), Installed: true}, testInstance(), nil
	}}
	if code := forgeAPICmdWith([]string{"setup", "--station", "stn_1", "--agent-uid", "1001"}, &o, &e, d); code != 0 {
		t.Fatalf("code %d: %s", code, e.String())
	}
	if gotID != "stn_1" || len(gotUIDs) != 1 || gotUIDs[0] != 1001 {
		t.Fatalf("station %q uids %v", gotID, gotUIDs)
	}
	for _, want := range []string{"isolation: separate-user", "instance:  stk-stn-1-abcdef (unit stk-stn-1-abcdef, proxy port 8900)"} {
		if !strings.Contains(o.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, o.String())
		}
	}
	// --station owns the user and state dir
	for _, bad := range [][]string{{"--user", "x"}, {"--state-dir", "/x"}, {"--stk", "/bin/stk"}} {
		var o2, e2 bytes.Buffer
		if code := forgeAPICmdWith(append([]string{"setup", "--station", "stn_1"}, bad...), &o2, &e2, d); code != 2 {
			t.Errorf("%v: code %d", bad, code)
		}
	}
	// an error exits 1 and still names the instance
	d.station = func(context.Context, string, []int, bool) (forgeapi.SetupResult, forgeapi.Instance, error) {
		return forgeapi.SetupResult{}, testInstance(), errors.New("boom")
	}
	var o3, e3 bytes.Buffer
	if code := forgeAPICmdWith([]string{"setup", "--station", "stn_1"}, &o3, &e3, d); code != 1 || !strings.Contains(e3.String(), "boom") {
		t.Fatalf("code %d: %s", code, e3.String())
	}
}

func TestForgeAPIUIDMappingAndAcknowledgementReachTheManager(t *testing.T) {
	c := config.ForgeAPI{StationUIDs: map[string][]int{"stn_1": {2001}, "stn_2": {2002, 2003}}}
	cfg, err := forgeAPIInstancesConfig(c, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.AgentUIDs("stn_2"); len(got) != 2 || got[1] != 2003 {
		t.Errorf("mapped uids = %v", got)
	}
	if got := cfg.AgentUIDs("stn_unmapped"); len(got) != 1 || got[0] != os.Geteuid() {
		t.Errorf("unmapped station = %v, want the node's own uid", got)
	}
	if cfg.AllowSharedAgentUID {
		t.Error("shared uid is acknowledged by default")
	}
	for _, v := range []string{"1", "true"} {
		cfg, _ = forgeAPIInstancesConfig(c, func(k string) string {
			if k == "AGENTPOD_ALLOW_SHARED_AGENT_UID" {
				return v
			}
			return ""
		})
		if !cfg.AllowSharedAgentUID {
			t.Errorf("env %q not honoured", v)
		}
	}
	c.AllowSharedAgentUID = true
	if cfg, _ = forgeAPIInstancesConfig(c, func(string) string { return "" }); !cfg.AllowSharedAgentUID {
		t.Error("config acknowledgement not honoured")
	}
}

func TestForgeAPISetupStationPassesTheSharedUIDAcknowledgement(t *testing.T) {
	var got bool
	d := forgeAPIDeps{station: func(_ context.Context, _ string, _ []int, allow bool) (forgeapi.SetupResult, forgeapi.Instance, error) {
		got = allow
		return forgeapi.SetupResult{}, forgeapi.Instance{}, nil
	}}
	var o, e bytes.Buffer
	if code := forgeAPICmdWith([]string{"setup", "--station", "s", "--allow-shared-agent-uid"}, &o, &e, d); code != 0 || !got {
		t.Fatalf("code %d allow %v: %s", code, got, e.String())
	}
}

func TestTheNodeWiresStationHarnessesThroughSystemdUserUnits(t *testing.T) {
	cfg, err := forgeAPIInstancesConfig(config.ForgeAPI{}, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	h := cfg.Harness
	if h == nil || h.Units == nil || h.DropInDir == nil || h.Running == nil || h.DaemonReload == nil {
		t.Fatalf("harness wiring is not configured: %+v", h)
	}
	// the root station and a station of a harness no per-station unit starts have no unit
	for _, key := range []string{"hermes", "openclaw", "claude-code:work"} {
		if u := h.Units(key); len(u) != 0 {
			t.Errorf("Units(%q) = %v", key, u)
		}
	}
}
