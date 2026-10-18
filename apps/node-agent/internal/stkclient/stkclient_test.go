package stkclient

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	secretEnvelope = "ENVELOPE-sealed-SECRET-0123456789abcdef"
	secretEnvVal   = "ENVVAL-distinct-secret-fedcba9876"
)

type call struct {
	name  string
	args  []string
	stdin []byte
	env   []string
}

// stub returns a Runner that records calls and replies from a fixed result.
func stub(out, errOut string, code int, err error, calls *[]call) Runner {
	return func(_ context.Context, name string, args []string, stdin []byte, env []string) ([]byte, []byte, int, error) {
		*calls = append(*calls, call{name, args, stdin, env})
		return []byte(out), []byte(errOut), code, err
	}
}

func newStub(out, errOut string, code int, err error) (Client, *[]call) {
	var calls []call
	c := New("/usr/bin/stk", Options{
		Env: map[string]string{"STK_HOME": "/var/lib/stk", "STK_TOKEN_X": secretEnvVal},
		Run: stub(out, errOut, code, err, &calls),
	})
	return c, &calls
}

func ctx() context.Context { return context.Background() }

func TestHandoverOpenPassesEnvelopeOnStdinOnly(t *testing.T) {
	c, calls := newStub(`{"service":"forge-x","stored":true}`, "", 0, nil)
	if err := c.HandoverOpen(ctx(), "forge-x", secretEnvelope); err != nil {
		t.Fatal(err)
	}
	got := (*calls)[0]
	if string(got.stdin) != secretEnvelope {
		t.Fatalf("stdin = %q", got.stdin)
	}
	want := []string{"handover", "open", "forge-x", "--json"}
	if !reflect.DeepEqual(got.args, want) {
		t.Fatalf("args = %v want %v", got.args, want)
	}
	for _, a := range append(got.args, got.env...) {
		if strings.Contains(a, secretEnvelope) {
			t.Fatalf("envelope leaked into %q", a)
		}
	}
}

func TestHandoverOpenRequiresStored(t *testing.T) {
	c, _ := newStub(`{"service":"forge-x","stored":false}`, "", 0, nil)
	if err := c.HandoverOpen(ctx(), "forge-x", secretEnvelope); err == nil {
		t.Fatal("stored:false must be an error")
	}
	c, _ = newStub(`{"service":"forge-x"}`, "", 0, nil)
	if err := c.HandoverOpen(ctx(), "forge-x", secretEnvelope); err == nil {
		t.Fatal("missing stored must be an error")
	}
}

func TestServiceNameCannotInjectFlags(t *testing.T) {
	c, calls := newStub(`{}`, "", 0, nil)
	for _, svc := range []string{"", "--json", "-x"} {
		if err := c.RevokeLocal(ctx(), svc); err == nil {
			t.Fatalf("service %q accepted", svc)
		}
	}
	if len(*calls) != 0 {
		t.Fatal("stk must not run for an invalid service name")
	}
}

func TestVerifyParsesOKLoginReason(t *testing.T) {
	c, calls := newStub(`{"ok":true,"login":"alice","reason":"","extra":1}`, "", 0, nil)
	r, err := c.Verify(ctx(), "forge-x", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if !r.OK || r.Login != "alice" || r.Reason != "" {
		t.Fatalf("got %+v", r)
	}
	want := []string{"verify", "forge-x", "--expect-login", "alice", "--json"}
	if !reflect.DeepEqual((*calls)[0].args, want) {
		t.Fatalf("args = %v", (*calls)[0].args)
	}
	c, calls = newStub(`{"ok":true,"login":"a","reason":""}`, "", 0, nil)
	if _, err := c.Verify(ctx(), "forge-x", ""); err != nil {
		t.Fatal(err)
	}
	for _, a := range (*calls)[0].args {
		if a == "--expect-login" {
			t.Fatal("--expect-login must be omitted when empty")
		}
	}
}

func TestVerifyParsesStdoutOnNonZeroExitAndPassesReasonUnchanged(t *testing.T) {
	c, _ := newStub(`{"ok":false,"login":"","reason":"login-mismatch"}`, "verify failed", 1, nil)
	r, err := c.Verify(ctx(), "forge-x", "alice")
	if err != nil {
		t.Fatalf("failed verification with JSON is a result, got err %v", err)
	}
	if r.OK || r.Reason != "login-mismatch" {
		t.Fatalf("got %+v", r)
	}
}

func TestVerifyRequiresOKField(t *testing.T) {
	c, _ := newStub(`{"login":"a"}`, "", 0, nil)
	if _, err := c.Verify(ctx(), "forge-x", ""); err == nil {
		t.Fatal("missing ok must be an error")
	}
}

func TestNonJSONStdoutIsErrorWithoutEchoingStdout(t *testing.T) {
	c, _ := newStub("<<STDOUT-CANARY-9931>> not json", "", 0, nil)
	_, err := c.Verify(ctx(), "forge-x", "")
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "STDOUT-CANARY-9931") {
		t.Fatalf("error echoes stdout: %v", err)
	}
	// non-zero exit with unparseable stdout is also an error
	c, _ = newStub("<<STDOUT-CANARY-9931>>", "boom", 2, nil)
	_, err = c.Verify(ctx(), "forge-x", "")
	if err == nil || strings.Contains(err.Error(), "STDOUT-CANARY-9931") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(err.Error(), "verify") || !strings.Contains(err.Error(), "2") {
		t.Fatalf("error should name the command and exit code: %v", err)
	}
}

func TestErrorsNeverContainSecrets(t *testing.T) {
	stderr := "bad thing with " + secretEnvelope + " and " + secretEnvVal + " tok=ghp_abcdefghijklmnopqrstuvwxyz0123456789"
	c, _ := newStub("garbage "+secretEnvelope+secretEnvVal, stderr, 3, nil)
	check := func(name string, err error) {
		t.Helper()
		if err == nil {
			t.Fatalf("%s: expected error", name)
		}
		m := err.Error()
		for _, s := range []string{secretEnvelope, secretEnvVal, "ghp_abcdefghijklmnopqrstuvwxyz0123456789"} {
			if strings.Contains(m, s) {
				t.Fatalf("%s: error leaks %q: %v", name, s, m)
			}
		}
	}
	check("open", c.HandoverOpen(ctx(), "forge-x", secretEnvelope))
	_, err := c.Verify(ctx(), "forge-x", "")
	check("verify", err)
	_, err = c.Reload(ctx())
	check("reload", err)
	_, err = c.Env(ctx())
	check("env", err)
	check("revoke", c.RevokeLocal(ctx(), "forge-x"))
	// runner-level failure carrying secrets in its own error text
	c, _ = newStub("", "", 0, errors.New("spawn failed env="+secretEnvVal))
	check("runner", c.HandoverOpen(ctx(), "forge-x", secretEnvelope))
}

func TestStderrTruncatedTo200Bytes(t *testing.T) {
	c, _ := newStub("", strings.Repeat("e", 5000), 1, nil)
	err := c.RevokeLocal(ctx(), "forge-x")
	if err == nil {
		t.Fatal("expected error")
	}
	if len(err.Error()) > 400 || strings.Count(err.Error(), "e") > 220 {
		t.Fatalf("error not truncated: %d bytes", len(err.Error()))
	}
}

func TestOldStkIsErrStkTooOld(t *testing.T) {
	for _, stderr := range []string{
		`stk verify: unknown argument "--json" (usage: stk verify <service>)`,
		"flag provided but not defined: -json",
		"unknown flag: --json",
	} {
		c, _ := newStub("", stderr, 2, nil)
		_, err := c.Verify(ctx(), "forge-x", "")
		if !errors.Is(err, ErrStkTooOld) {
			t.Fatalf("stderr %q: err = %v", stderr, err)
		}
	}
}

func TestMissingBinaryIsErrStkMissing(t *testing.T) {
	c := New(filepath.Join(t.TempDir(), "no-such-stk"), Options{})
	_, err := c.Version(ctx())
	if !errors.Is(err, ErrStkMissing) {
		t.Fatalf("err = %v", err)
	}
	// 127 from a wrapper (runuser) means the same
	c, _ = newStub("", "runuser: failed to execute stk: No such file or directory", 127, nil)
	if _, err := c.Version(ctx()); !errors.Is(err, ErrStkMissing) {
		t.Fatalf("127: err = %v", err)
	}
}

func TestNonExecutableBinaryIsErrStkNotRunnable(t *testing.T) {
	p := filepath.Join(t.TempDir(), "stk")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := New(p, Options{}).Version(ctx())
	if !errors.Is(err, ErrStkNotRunnable) {
		t.Fatalf("err = %v", err)
	}
	c, _ := newStub("", "permission denied", 126, nil)
	if _, err := c.Version(ctx()); !errors.Is(err, ErrStkNotRunnable) {
		t.Fatalf("126: err = %v", err)
	}
}

func TestRunAsWrapsWithRunuserOnlyWhenRootAndRequested(t *testing.T) {
	run := func(runAs string, euid int) call {
		var calls []call
		c := New("/usr/local/bin/stk", Options{RunAs: runAs, geteuid: func() int { return euid }, Run: stub(`stk 0.0.1`, "", 0, nil, &calls)})
		if _, err := c.Version(ctx()); err != nil {
			t.Fatal(err)
		}
		return calls[0]
	}
	got := run("stk", 0)
	if got.name != "runuser" || !reflect.DeepEqual(got.args, []string{"-u", "stk", "--", "/usr/local/bin/stk", "version"}) {
		t.Fatalf("root+RunAs: %s %v", got.name, got.args)
	}
	if got := run("stk", 1000); got.name != "/usr/local/bin/stk" || got.args[0] != "version" {
		t.Fatalf("non-root: %s %v", got.name, got.args)
	}
	if got := run("", 0); got.name != "/usr/local/bin/stk" {
		t.Fatalf("no RunAs: %s %v", got.name, got.args)
	}
}

func TestRunAsRejectsOptionLookingUser(t *testing.T) {
	var calls []call
	c := New("/usr/local/bin/stk", Options{RunAs: "-evil", geteuid: func() int { return 0 }, Run: stub(`stk 0.0.1`, "", 0, nil, &calls)})
	if _, err := c.Version(ctx()); err == nil {
		t.Fatal("RunAs starting with '-' must be rejected")
	}
}

func TestEnvIsMinimalAndOnlyOptionsEnv(t *testing.T) {
	t.Setenv("INHERITED_SENTINEL", "leak-me")
	var calls []call
	c := New("/usr/bin/stk", Options{
		Env: map[string]string{"STK_HOME": "/h", "STK_SOCKET": "/s"},
		Run: stub(`stk 0.0.1`, "", 0, nil, &calls),
	})
	if _, err := c.Version(ctx()); err != nil {
		t.Fatal(err)
	}
	env := calls[0].env
	want := []string{"PATH=" + os.Getenv("PATH"), "STK_HOME=/h", "STK_SOCKET=/s"}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("env = %v want %v", env, want)
	}
}

func TestDefaultRunnerDoesNotInheritEnvironment(t *testing.T) {
	t.Setenv("INHERITED_SENTINEL", "leak-me")
	self, _ := os.Executable()
	out, _, code, err := DefaultRunner(ctx(), self, nil, nil, []string{"PATH=" + os.Getenv("PATH"), "STKCLIENT_STUB=env", "KEPT=1"})
	if err != nil || code != 0 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	var env []string
	if err := json.Unmarshal(out, &env); err != nil {
		t.Fatal(err)
	}
	for _, kv := range env {
		if strings.HasPrefix(kv, "INHERITED_SENTINEL") {
			t.Fatalf("child inherited %q", kv)
		}
	}
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "KEPT=1") {
		t.Fatalf("explicit env missing: %v", env)
	}
}

func TestDefaultRunnerCapsOutput(t *testing.T) {
	self, _ := os.Executable()
	out, errOut, code, err := DefaultRunner(ctx(), self, nil, nil, []string{"STKCLIENT_STUB=flood"})
	if err != nil || code != 0 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	if len(out) != 64*1024 || len(errOut) != 64*1024 {
		t.Fatalf("stdout=%d stderr=%d, want 65536 each", len(out), len(errOut))
	}
}

func TestOversizedOutputIsAnErrorNotAPartialParse(t *testing.T) {
	self, _ := os.Executable()
	c := New(self, Options{Env: map[string]string{"STKCLIENT_STUB": "flood"}})
	_, err := c.Verify(ctx(), "forge-x", "")
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "xxxxxxxx") {
		t.Fatalf("error echoes output: %.80s", err)
	}
}

func TestTimeoutReturnsErrorAndKillsChild(t *testing.T) {
	self, _ := os.Executable()
	pidfile := filepath.Join(t.TempDir(), "pid")
	c := New(self, Options{
		Timeout: 400 * time.Millisecond,
		Env:     map[string]string{"STKCLIENT_STUB": "sleep", "STKCLIENT_PIDFILE": pidfile},
	})
	start := time.Now()
	_, err := c.Version(ctx())
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("took %v", time.Since(start))
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v", err)
	}
	b, rerr := os.ReadFile(pidfile)
	if rerr != nil {
		t.Fatalf("stub never started: %v", rerr)
	}
	pid, _ := strconv.Atoi(string(b))
	if kerr := syscall.Kill(pid, 0); kerr != syscall.ESRCH {
		t.Fatalf("child %d still alive (kill -0 => %v)", pid, kerr)
	}
}

func TestProbeParsesOutcomesOnNonZeroExit(t *testing.T) {
	c, calls := newStub(`[{"client":"curl","outcome":"honoured","detail":"ok"},{"client":"git","outcome":"bypassed","detail":"direct"}]`, "", 1, nil)
	got, err := c.Probe(ctx())
	if err != nil {
		t.Fatal(err)
	}
	want := []ProbeOutcome{{"curl", "honoured", "ok"}, {"git", "bypassed", "direct"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	if !reflect.DeepEqual((*calls)[0].args, []string{"doctor", "--probe", "--json"}) {
		t.Fatalf("args = %v", (*calls)[0].args)
	}
	c, _ = newStub(`not json`, "", 1, nil)
	if _, err := c.Probe(ctx()); err == nil {
		t.Fatal("garbage must be an error")
	}
}

func TestReloadParsesRemovedAddedChanged(t *testing.T) {
	c, calls := newStub(`{"ok":true,"removed":["a"],"added":["b","c"],"changed":["d"],"credentials_kept":["z"]}`, "", 0, nil)
	r, err := c.Reload(ctx())
	if err != nil {
		t.Fatal(err)
	}
	if !r.OK || !reflect.DeepEqual(r.Removed, []string{"a"}) || !reflect.DeepEqual(r.Added, []string{"b", "c"}) || !reflect.DeepEqual(r.Changed, []string{"d"}) {
		t.Fatalf("got %+v", r)
	}
	if !reflect.DeepEqual((*calls)[0].args, []string{"reload", "--json"}) {
		t.Fatalf("args = %v", (*calls)[0].args)
	}
	c, _ = newStub(`{"ok":false,"error":"bad policy"}`, "", 1, nil)
	r, err = c.Reload(ctx())
	if err != nil || r.OK || r.Error != "bad policy" {
		t.Fatalf("got %+v err %v", r, err)
	}
	c, _ = newStub(`{"removed":[]}`, "", 0, nil)
	if _, err := c.Reload(ctx()); err == nil {
		t.Fatal("missing ok must be an error")
	}
}

func TestRevokeLocalArgs(t *testing.T) {
	c, calls := newStub("", "", 0, nil)
	if err := c.RevokeLocal(ctx(), "forge-x"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual((*calls)[0].args, []string{"revoke", "forge-x", "--local"}) {
		t.Fatalf("args = %v", (*calls)[0].args)
	}
	c, _ = newStub("", "denied", 1, nil)
	if err := c.RevokeLocal(ctx(), "forge-x"); err == nil {
		t.Fatal("non-zero exit must be an error")
	}
}

func TestEnvParses(t *testing.T) {
	c, calls := newStub(`{"proxy_url":"http://127.0.0.1:8899","ca_path":"/run/stk/ca.pem","env":{"HTTPS_PROXY":"http://127.0.0.1:8899","X":"y"}}`, "", 0, nil)
	e, err := c.Env(ctx())
	if err != nil {
		t.Fatal(err)
	}
	if e.ProxyURL != "http://127.0.0.1:8899" || e.CAPath != "/run/stk/ca.pem" || e.Vars["X"] != "y" || len(e.Vars) != 2 {
		t.Fatalf("got %+v", e)
	}
	if !reflect.DeepEqual((*calls)[0].args, []string{"env", "--json"}) {
		t.Fatalf("args = %v", (*calls)[0].args)
	}
	c, _ = newStub(`{"ca_path":"/x"}`, "", 0, nil)
	if _, err := c.Env(ctx()); err == nil {
		t.Fatal("missing proxy_url must be an error")
	}
}

func TestDoctorParses(t *testing.T) {
	c, calls := newStub(`{"checks":[{"name":"state","ok":true,"detail":"fine"},{"name":"x","ok":true,"warn":true,"detail":"hm"}],"isolation":{"level":"separate-user","method":"uid","reasons":["a","b"]},"future":1}`, "", 0, nil)
	d, err := c.Doctor(ctx())
	if err != nil {
		t.Fatal(err)
	}
	if d.Isolation.Level != "separate-user" || d.Isolation.Method != "uid" || !reflect.DeepEqual(d.Isolation.Reasons, []string{"a", "b"}) {
		t.Fatalf("isolation %+v", d.Isolation)
	}
	if len(d.Checks) != 2 || d.Checks[0].Name != "state" || !d.Checks[1].Warn || d.Checks[1].Detail != "hm" {
		t.Fatalf("checks %+v", d.Checks)
	}
	if !reflect.DeepEqual((*calls)[0].args, []string{"doctor", "--json"}) {
		t.Fatalf("args = %v", (*calls)[0].args)
	}
	c, _ = newStub(`{"checks":[]}`, "", 0, nil)
	if _, err := c.Doctor(ctx()); err == nil {
		t.Fatal("missing isolation.level must be an error")
	}
}

func TestVersionAndHandoverKey(t *testing.T) {
	c, _ := newStub("stk 0.0.3\n", "", 0, nil)
	v, err := c.Version(ctx())
	if err != nil || v != "0.0.3" {
		t.Fatalf("v=%q err=%v", v, err)
	}
	c, calls := newStub(`{"public_key":"age1abc"}`, "", 0, nil)
	k, err := c.HandoverKey(ctx())
	if err != nil || k != "age1abc" {
		t.Fatalf("k=%q err=%v", k, err)
	}
	if !reflect.DeepEqual((*calls)[0].args, []string{"handover", "key", "--json"}) {
		t.Fatalf("args = %v", (*calls)[0].args)
	}
	c, _ = newStub(`{}`, "", 0, nil)
	if _, err := c.HandoverKey(ctx()); err == nil {
		t.Fatal("missing public_key must be an error")
	}
}

func TestInstallPassesFlagsAsArgumentVector(t *testing.T) {
	c, calls := newStub("installed user stk\nca at /run/stk/ca.pem\n", "", 0, nil)
	rep, err := c.Install(ctx(), InstallPlan{
		User: "stk", Group: "stk", StateDir: "/var/lib/stk", RuntimeDir: "/run/stk",
		ConfigPath: "/etc/stk/x y.yaml", AgentUIDs: []int{1001, 1002}, ProxyPort: 8899, DryRun: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"install", "--user", "stk", "--group", "stk", "--state-dir", "/var/lib/stk",
		"--runtime-dir", "/run/stk", "--config", "/etc/stk/x y.yaml",
		"--agent-uid", "1001", "--agent-uid", "1002", "--proxy-port", "8899", "--dry-run"}
	if !reflect.DeepEqual((*calls)[0].args, want) {
		t.Fatalf("args = %v", (*calls)[0].args)
	}
	if !strings.Contains(rep.Output, "installed user stk") {
		t.Fatalf("output = %q", rep.Output)
	}
	// an option-looking user is rejected, not passed through as a flag
	if _, err := c.Install(ctx(), InstallPlan{User: "--dry-run"}); err == nil {
		t.Fatal("User starting with '-' must be rejected")
	}
	if _, err := c.Install(ctx(), InstallPlan{}); err == nil {
		t.Fatal("User is required")
	}
}

func TestInstallOutputIsScrubbed(t *testing.T) {
	c, _ := newStub("done "+secretEnvVal+"\n", "", 0, nil)
	rep, err := c.Install(ctx(), InstallPlan{User: "stk"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rep.Output, secretEnvVal) {
		t.Fatalf("install output leaks env value: %q", rep.Output)
	}
}

func TestStderrIsScrubbedOfStdinAndEnv(t *testing.T) {
	c, _ := newStub("", "failed: "+secretEnvelope, 1, nil)
	err := c.HandoverOpen(ctx(), "forge-x", secretEnvelope)
	if err == nil || strings.Contains(err.Error(), secretEnvelope) {
		t.Fatalf("err = %v", err)
	}
}
