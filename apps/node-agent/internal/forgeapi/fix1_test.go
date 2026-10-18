package forgeapi

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// ---- 1. a station key belongs to one station ----

func TestASecondStationCannotTakeAKeyAnotherStationHolds(t *testing.T) {
	fx, _ := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	p := deliverParams("fag_bbb222", "forge.example.com")
	p.StationID, p.StationKey = "stn_2", "hermes:stn_1" // stn_1's key
	p.Sealed = Sealed(HandoverPrefix + "SEALED-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	_, err := fx.m.Deliver(context.Background(), p)
	if err == nil || !strings.HasPrefix(err.Error(), "station-key-in-use:") {
		t.Fatalf("err = %v", err)
	}
	if _, ok := fx.m.Instance("stn_2"); ok {
		t.Error("an instance was created for the refused station")
	}
	env, _ := fx.m.EnvForKey("hermes:stn_1")
	i1, _ := fx.m.Instance("stn_1")
	if !strings.Contains(env["HTTPS_PROXY"], "KEY-"+i1.Name) || env["FORGEJO_TOKEN"] != "stk:ref:forge-forgejo-aaa111:v1" {
		t.Errorf("the key's owner lost its env: %v", env)
	}
	for k, v := range env {
		if strings.Contains(v, "bbb222") {
			t.Errorf("%s carries the refused station's placeholder", k)
		}
	}
}

func TestAKeyHeldByTwoRecordsGetsNoEnvAtAllWhateverTheMapOrder(t *testing.T) {
	fx, _ := newWiringFixture(t)
	for _, s := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliverKeyed(s, "fag_"+s, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	// a stale or forged registry: both records claim stn_1's key
	if err := fx.m.updateRecords(func(recs map[string]record) (bool, error) {
		r := recs["stn_2"]
		r.StationKey = "hermes:stn_1"
		recs["stn_2"] = r
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	i1, _ := fx.m.Instance("stn_1")
	i2, _ := fx.m.Instance("stn_2")
	for i := 0; i < 200; i++ {
		env, hosts := fx.m.EnvForKey("hermes:stn_1")
		if env != nil || hosts != nil {
			t.Fatalf("run %d: an ambiguous key got %v", i, env)
		}
	}
	logs := fx.joinedLogs()
	if !strings.Contains(logs, "more than one") {
		t.Error("the ambiguity was not logged")
	}
	if strings.Contains(logs, "KEY-"+i1.Name) || strings.Contains(logs, "KEY-"+i2.Name) {
		t.Error("a proxy credential was logged")
	}
}

func TestTwoStationsNeverShareAUnitsDropIn(t *testing.T) {
	fx, _ := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) {
		c.Harness.Units = func(string) []string { return []string{"hermes-gateway-shared.service"} }
	})
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	_, err := fx.deliverKeyed("stn_2", "fag_bbb222", "forge.example.com")
	if err == nil || !strings.HasPrefix(err.Error(), "harness-unit-in-use:") {
		t.Fatalf("err = %v", err)
	}
}

// ---- 2. an agent-owned directory cannot turn the node's chown or write into a symlink ----

func TestASymlinkAtTheEnvFilePathIsRefusedAndNothingOutsideIsTouched(t *testing.T) {
	fx, w := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(outside, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := fx.envFile("stn_1")
	if err := os.Remove(f); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, f); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.chowns, w.fchowns = nil, nil
	w.mu.Unlock()
	_, err := fx.deliverKeyed("stn_1", "fag_ccc333", "other.example.com")
	if err == nil || !strings.HasPrefix(err.Error(), "harness-wiring-failed:") {
		t.Fatalf("err = %v", err)
	}
	if b, _ := os.ReadFile(outside); string(b) != "precious" {
		t.Errorf("the target was written: %q", b)
	}
	if st, _ := os.Stat(outside); st.Mode().Perm() != 0o644 {
		t.Errorf("target mode = %v", st.Mode().Perm())
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, c := range append(append([]chownCall{}, w.chowns...), w.fchowns...) {
		if c.path == outside || c.path == f {
			t.Errorf("chown on %s: a symlink there would be followed", c.path)
		}
	}
}

func TestASymlinkInPlaceOfTheInstanceDirectoryIsRefused(t *testing.T) {
	fx, w := newWiringFixture(t)
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	inst, _ := fx.m.Instance("stn_1")
	outside := t.TempDir()
	if err := os.Chmod(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(fx.cfg.Harness.Root, 0o711); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(fx.cfg.Harness.Root, inst.Name)
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	_, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err == nil || !strings.HasPrefix(err.Error(), "harness-wiring-failed:") {
		t.Fatalf("err = %v", err)
	}
	if st, _ := os.Stat(outside); st.Mode().Perm() != 0o755 {
		t.Errorf("the symlink target was chmodded to %v", st.Mode().Perm())
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Errorf("files were written through the symlink: %v", entries)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, c := range append(append([]chownCall{}, w.chowns...), w.fchowns...) {
		if strings.HasPrefix(c.path, outside) || c.path == link {
			t.Errorf("chown through the symlink: %+v", c)
		}
	}
}

// ---- 3. a proxy variable that is already set blocks the broker for that spawn ----

func TestAPresetProxyVariableBlocksTheBrokerLeavesTheEnvUnchangedAndSaysSo(t *testing.T) {
	for _, name := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		t.Run(name, func(t *testing.T) {
			lines := captureEnvLogs(t)
			secret := "http://user:SECRETPW@corp-proxy:3128"
			env := []string{"FOO=1", name + "=" + secret}
			var gotKey string
			var gotNames []string
			inner := func(string) ([]string, string, []string, error) { return nil, "", env, nil }
			lookup := func(string) (map[string]string, []string) {
				return map[string]string{"HTTPS_PROXY": "http://stk:K@127.0.0.1:1", "https_proxy": "http://stk:K@127.0.0.1:1", "SSL_CERT_FILE": "/ca.pem"}, nil
			}
			cmd := WithBrokerCommand(inner, lookup, func(k string, n []string) { gotKey, gotNames = k, n })
			for i := 0; i < 3; i++ {
				_, _, out, _ := cmd("hermes:press")
				if fmt.Sprint(out) != fmt.Sprint(env) {
					t.Fatalf("a blocked spawn must be unchanged: %v", out)
				}
			}
			if gotKey != "hermes:press" || fmt.Sprint(gotNames) != "["+name+"]" {
				t.Errorf("onBlocked(%q, %v)", gotKey, gotNames)
			}
			n := 0
			for _, l := range *lines {
				if strings.Contains(l, "SECRETPW") || strings.Contains(l, "corp-proxy") {
					t.Errorf("a value was logged: %q", l)
				}
				if strings.Contains(l, "WARNING") && strings.Contains(l, name) && strings.Contains(l, "hermes:press") {
					n++
				}
			}
			if n != 1 {
				t.Errorf("warnings = %d, want 1 (%v)", n, *lines)
			}
		})
	}
}

func TestAnUnblockedSpawnTellsTheCallbackThereIsNothingBlocking(t *testing.T) {
	captureEnvLogs(t)
	called := false
	cmd := WithBrokerCommand(
		func(string) ([]string, string, []string, error) { return nil, "", []string{"FOO=1"}, nil },
		func(string) (map[string]string, []string) {
			return map[string]string{"HTTPS_PROXY": "p", "https_proxy": "p"}, nil
		},
		func(_ string, n []string) { called = len(n) == 0 },
	)
	if _, _, out, _ := cmd("k"); !contains(out, "HTTPS_PROXY=p") {
		t.Fatalf("out = %v", out)
	}
	if !called {
		t.Error("the callback must be told the key is not blocked, so a stale reason clears")
	}
}

func TestTheBrokerSetsBothCasesToOneProxy(t *testing.T) {
	v := goodVars()
	v["https_proxy"] = "http://stk:OTHER@127.0.0.1:9"
	v["http_proxy"] = "http://stk:OTHER@127.0.0.1:9"
	c := envClient{env: stkEnv("http://stk:PROXYKEY@127.0.0.1:8901", "/ca.pem", v)}
	got, err := BrokerEnv(t.Context(), c, "stn_1")
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range proxyURLVars {
		if got[k] != "http://stk:PROXYKEY@127.0.0.1:8901" {
			t.Errorf("%s = %q: two cases must not name two proxies", k, got[k])
		}
	}
}

func TestADifferingCAVariableIsKeptAndWarnedAboutByNameOnly(t *testing.T) {
	lines := captureEnvLogs(t)
	env := []string{"SSL_CERT_FILE=/corp/SECRETPATH.pem", "CURL_CA_BUNDLE=/ca.pem"}
	add := map[string]string{"HTTPS_PROXY": "p", "SSL_CERT_FILE": "/ca.pem", "CURL_CA_BUNDLE": "/ca.pem"}
	got := WithBrokerEnv(env, add)
	if !contains(got, "SSL_CERT_FILE=/corp/SECRETPATH.pem") || contains(got, "SSL_CERT_FILE=/ca.pem") {
		t.Fatalf("the descriptor's CA must win: %v", got)
	}
	n := 0
	for _, l := range *lines {
		if strings.Contains(l, "SECRETPATH") || strings.Contains(l, "/ca.pem") {
			t.Errorf("a value was logged: %q", l)
		}
		if strings.Contains(l, "WARNING") && strings.Contains(l, "SSL_CERT_FILE") {
			n++
		}
		if strings.Contains(l, "CURL_CA_BUNDLE") {
			t.Errorf("an identical CA variable was warned about: %q", l)
		}
	}
	if n != 1 {
		t.Errorf("warnings = %d (%v)", n, *lines)
	}
}

func TestAUnitThatAlreadySetsAProxyGetsNoDropInAndTheReasonIsKept(t *testing.T) {
	fx, w := newWiringFixture(t)
	w.mu.Lock()
	w.unitEnv = []string{"https_proxy=http://corp:SECRETPW@proxy:3128", "FOO=1"}
	w.mu.Unlock()
	ack, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err != nil || !ack.OK {
		t.Fatalf("%+v %v", ack, err)
	}
	if exists(fx.envFile("stn_1")) || exists(fx.dropIn("stn_1")) || len(ack.Wired) != 0 {
		t.Error("a unit with its own proxy must not be half-wired")
	}
	r := fx.m.WiringBlocked("stn_1")
	if !strings.Contains(r, "https_proxy") || !strings.Contains(r, unitOf("hermes:stn_1")) || strings.Contains(r, "SECRETPW") {
		t.Errorf("WiringBlocked = %q", r)
	}
	if strings.Contains(fx.joinedLogs(), "SECRETPW") {
		t.Error("a value was logged")
	}
	// once the unit stops setting it, the next wiring clears the reason
	w.mu.Lock()
	w.unitEnv = nil
	w.mu.Unlock()
	ack, err = fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err != nil || len(ack.Wired) != 1 || fx.m.WiringBlocked("stn_1") != "" {
		t.Fatalf("%+v %v blocked=%q", ack, err, fx.m.WiringBlocked("stn_1"))
	}
}

func TestAUnitsNoProxyThatCoversTheForgeIsWarnedAboutOnTheDropInPathToo(t *testing.T) {
	fx, w := newWiringFixture(t)
	w.mu.Lock()
	w.unitEnv = []string{"NO_PROXY=.example.com"}
	w.mu.Unlock()
	resetNoProxyWarned()
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fx.joinedLogs(), "WARNING: NO_PROXY") {
		t.Error("no warning")
	}
	if strings.Contains(strings.ToLower(readOrEmpty(fx.envFile("stn_1"))), "no_proxy") {
		t.Error("the node wrote a NO_PROXY")
	}
}

func TestSpawnNoteBlockedIsReportedPerStationAndClears(t *testing.T) {
	fx, _ := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	fx.m.NoteBlocked("hermes:stn_1", []string{"HTTPS_PROXY"})
	if r := fx.m.WiringBlocked("stn_1"); !strings.Contains(r, "HTTPS_PROXY") {
		t.Fatalf("blocked = %q", r)
	}
	if fx.m.WiringBlocked("stn_2") != "" {
		t.Error("another station reports it")
	}
	fx.m.NoteBlocked("hermes:stn_1", nil)
	if fx.m.WiringBlocked("stn_1") != "" {
		t.Error("not cleared")
	}
}

// ---- 4. minors ----

func TestWiredNamesTheUnitsAndANeedsRestartIsLogged(t *testing.T) {
	fx, w := newWiringFixture(t)
	w.setRunning(unitOf("hermes:stn_1"), true)
	ack, err := fx.deliverKeyed("stn_1", "fag_aaa111", "forge.example.com")
	if err != nil || fmt.Sprint(ack.Wired) != "["+unitOf("hermes:stn_1")+"]" || !ack.NeedsRestart {
		t.Fatalf("%+v %v", ack, err)
	}
	if !strings.Contains(fx.joinedLogs(), "needs a restart") {
		t.Error("needsRestart was not logged")
	}
	rev, err := fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"})
	if err != nil || len(rev.Wired) != 0 || !rev.NeedsRestart {
		t.Fatalf("%+v %v", rev, err)
	}
}

func stkEnv(proxy, ca string, vars map[string]string) stkclient.Env {
	return stkclient.Env{ProxyURL: proxy, CAPath: ca, Vars: vars}
}

func TestTheRegistryRefusesADuplicateKeyEvenWhenTheEarlyCheckWasRaced(t *testing.T) {
	fx, _ := newWiringFixture(t)
	for _, s := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliverKeyed(s, "fag_"+s, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	if err := fx.m.recordKey("stn_2", "hermes:stn_1"); err == nil || !strings.HasPrefix(err.Error(), "station-key-in-use:") {
		t.Fatalf("err = %v", err)
	}
	if rec, _ := fx.m.readRecords(); rec["stn_2"].StationKey != "hermes:stn_2" {
		t.Errorf("the record changed: %+v", rec["stn_2"])
	}
}
