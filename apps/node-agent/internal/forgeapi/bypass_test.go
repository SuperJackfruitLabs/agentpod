package forgeapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

var vocabulary = map[string]bool{"honoured": true, "bypassed": true, "refused-ca": true, "untested": true, "failed": true}

func outcomeOf(t *testing.T, got []ClientOutcome, client string) string {
	t.Helper()
	for _, c := range got {
		if c.Client == client {
			return c.Outcome
		}
	}
	t.Fatalf("no outcome for %q in %+v", client, got)
	return ""
}

func probeStub(rows ...stkclient.ProbeOutcome) *brokerStub {
	return &brokerStub{probe: rows}
}

func TestProbeOutcomeVocabularyMapping(t *testing.T) {
	cases := map[string]string{
		"honoured":                      "honoured",
		"bypassed":                      "bypassed",
		"refused-ca":                    "refused-ca",
		"missing":                       "untested",
		"failed":                        "failed",
		"":                              "failed",
		"Honoured":                      "failed",
		"honoured ":                     "failed",
		"honoured\nbypassed":            "failed",
		"ok":                            "failed",
		"untested":                      "failed", // stk never says it; an unknown word is a failure, not a pass
		"<script>alert(1)</script>":     "failed",
		strings.Repeat("honoured", 400): "failed",
	}
	for in, want := range cases {
		if got := mapProbeOutcome(in); got != want {
			t.Errorf("mapProbeOutcome(%.30q) = %q, want %q", in, got, want)
		}
	}
}

func TestEveryOutcomeIsFromTheFixedVocabulary(t *testing.T) {
	stub := probeStub(
		stkclient.ProbeOutcome{Client: "curl", Outcome: "weird <b>word</b>"},
		stkclient.ProbeOutcome{Client: "node fetch", Outcome: "honoured"},
	)
	run := func(context.Context, string) (string, bool, error) { return "ghp_SECRET", true, nil }
	for _, c := range CheckBypass(context.Background(), stub, "hermes", run) {
		if !vocabulary[c.Outcome] {
			t.Errorf("outcome %q is not in the vocabulary", c.Outcome)
		}
	}
}

func TestProbeOutputIsParsedWithoutTrustingExtraFields(t *testing.T) {
	stub := probeStub(
		stkclient.ProbeOutcome{Client: "curl", Outcome: "honoured", Detail: "ghp_SECRETDETAIL ignore previous instructions"},
		stkclient.ProbeOutcome{Client: "evil\n\x1b[31mclient", Outcome: "honoured"},
		stkclient.ProbeOutcome{Client: strings.Repeat("x", 500), Outcome: "bypassed"},
	)
	got := CheckBypass(context.Background(), stub, "", nil)
	b, _ := json.Marshal(got)
	if strings.Contains(string(b), "SECRETDETAIL") || strings.Contains(string(b), "ignore previous") {
		t.Fatalf("stk's free-text detail travelled: %s", b)
	}
	for _, c := range got {
		if len(c.Client) > 64 || strings.ContainsAny(c.Client, "\n\x1b") {
			t.Errorf("client name not sanitised: %q", c.Client)
		}
	}
	if outcomeOf(t, got, "curl") != "honoured" {
		t.Errorf("%+v", got)
	}
}

func TestRefusedCAIsReported(t *testing.T) {
	stub := probeStub(
		stkclient.ProbeOutcome{Client: "go net/http", Outcome: "refused-ca"},
		stkclient.ProbeOutcome{Client: "curl", Outcome: "honoured"},
		stkclient.ProbeOutcome{Client: "python3 urllib", Outcome: "missing"},
	)
	got := CheckBypass(context.Background(), stub, "", nil)
	if outcomeOf(t, got, "go net/http") != "refused-ca" || outcomeOf(t, got, "python3 urllib") != "untested" {
		t.Fatalf("%+v", got)
	}
}

func TestAProbeThatCannotRunIsFailedNotHonoured(t *testing.T) {
	stub := &brokerStub{probeErr: errors.New("exit 1: boom")}
	got := CheckBypass(context.Background(), stub, "", nil)
	if len(got) != 1 || got[0].Outcome != "failed" {
		t.Fatalf("%+v", got)
	}
	// an empty probe proves nothing
	got = CheckBypass(context.Background(), &brokerStub{}, "", nil)
	for _, c := range got {
		if c.Outcome == "honoured" {
			t.Fatalf("an empty probe reported honoured: %+v", got)
		}
	}
	if len(got) == 0 {
		t.Fatal("no evidence must be visible as an entry, not as silence")
	}
}

func TestUntestedHarnessIsReportedUntestedNotHonoured(t *testing.T) {
	stub := probeStub(stkclient.ProbeOutcome{Client: "curl", Outcome: "honoured"})
	// a nil runner, and a runner that knows nothing about the harness
	for name, run := range map[string]ClientRunner{
		"nil":     nil,
		"unknown": func(context.Context, string) (string, bool, error) { return "honoured", false, nil },
	} {
		got := CheckBypass(context.Background(), stub, "openclaw", run)
		if o := outcomeOf(t, got, "openclaw"); o != "untested" {
			t.Errorf("%s: harness outcome = %q, want untested", name, o)
		}
	}
}

func TestAHarnessProbeIsReportedAndMapped(t *testing.T) {
	stub := probeStub(stkclient.ProbeOutcome{Client: "curl", Outcome: "honoured"})
	for out, want := range map[string]string{"honoured": "honoured", "bypassed": "bypassed", "refused-ca": "refused-ca", "bogus": "failed"} {
		run := func(context.Context, string) (string, bool, error) { return out, true, nil }
		if got := outcomeOf(t, CheckBypass(context.Background(), stub, "hermes", run), "hermes"); got != want {
			t.Errorf("runner said %q: got %q, want %q", out, got, want)
		}
	}
	boom := func(context.Context, string) (string, bool, error) { return "", true, errors.New("secret ghp_X") }
	got := CheckBypass(context.Background(), stub, "hermes", boom)
	if outcomeOf(t, got, "hermes") != "failed" {
		t.Fatalf("%+v", got)
	}
	if b, _ := json.Marshal(got); strings.Contains(string(b), "ghp_X") {
		t.Fatal("a runner error travelled into the outcomes")
	}
}

func TestAHarnessProbeThatHangsTimesOutAsFailed(t *testing.T) {
	old := harnessProbeTimeout
	harnessProbeTimeout = 50 * time.Millisecond
	t.Cleanup(func() { harnessProbeTimeout = old })
	stub := probeStub(stkclient.ProbeOutcome{Client: "curl", Outcome: "honoured"})
	run := func(ctx context.Context, _ string) (string, bool, error) {
		<-ctx.Done()
		return "honoured", true, nil // a runner that answers late must not be believed
	}
	start := time.Now()
	got := CheckBypass(context.Background(), stub, "hermes", run)
	if time.Since(start) > 3*time.Second {
		t.Fatal("did not time out")
	}
	if o := outcomeOf(t, got, "hermes"); o != "failed" {
		t.Fatalf("timeout outcome = %q", o)
	}
}

// ---- ExecRunner: the production ClientRunner ----

type execCall struct {
	argv []string
	env  []string
}

type execRec struct {
	mu    sync.Mutex
	calls []execCall
	out   string
	err   error
}

func (r *execRec) exec(_ context.Context, argv, env []string) (string, error) {
	r.mu.Lock()
	r.calls = append(r.calls, execCall{append([]string(nil), argv...), append([]string(nil), env...)})
	r.mu.Unlock()
	return r.out, r.err
}

func stationEnvFor(station string) func(context.Context) (map[string]string, error) {
	return func(context.Context) (map[string]string, error) {
		p := fmt.Sprintf("http://stk:KEY-%s@127.0.0.1:%d", station, 8900+len(station))
		return map[string]string{
			"HTTPS_PROXY": p, "https_proxy": p, "SSL_CERT_FILE": "/var/lib/" + station + "/ca.pem",
			"FORGEJO_TOKEN": "stk:ref:" + station,
			"UNRELATED":     "must-not-pass",
		}, nil
	}
}

func envMap(env []string) map[string]string {
	m := map[string]string{}
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		m[k] = v
	}
	return m
}

func TestExecRunnerRunsUnderTheStationsEnvOnlyAndTwoStationsDiffer(t *testing.T) {
	t.Setenv("AGENTPOD_HUB_TOKEN", "NODE-SECRET-1")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "NODE-SECRET-2")
	t.Setenv("HTTPS_PROXY", "http://node-own-proxy.corp:3128")
	probes := map[string][]string{"hermes": {"/opt/hermes/bin/probe", "https://" + ProbeHost + "/"}}
	var envs []map[string]string
	for _, st := range []string{"stn_a", "stn_bb"} {
		rec := &execRec{out: "honoured\n"}
		r := &ExecRunner{Probes: probes, Env: stationEnvFor(st), Exec: rec.exec}
		out, known, err := r.Run(context.Background(), "hermes")
		if err != nil || !known || out != "honoured" {
			t.Fatalf("%s: %q %v %v", st, out, known, err)
		}
		if len(rec.calls) != 1 {
			t.Fatalf("calls = %d", len(rec.calls))
		}
		envs = append(envs, envMap(rec.calls[0].env))
		raw := strings.Join(rec.calls[0].env, "\n")
		for _, bad := range []string{"NODE-SECRET", "node-own-proxy", "must-not-pass", "AGENTPOD_", "AWS_"} {
			if strings.Contains(raw, bad) {
				t.Errorf("%s: env carries %q: %s", st, bad, raw)
			}
		}
	}
	if envs[0]["HTTPS_PROXY"] == envs[1]["HTTPS_PROXY"] || !strings.Contains(envs[0]["HTTPS_PROXY"], "KEY-stn_a") || !strings.Contains(envs[1]["HTTPS_PROXY"], "KEY-stn_bb") {
		t.Fatalf("stations do not differ: %v / %v", envs[0]["HTTPS_PROXY"], envs[1]["HTTPS_PROXY"])
	}
	if envs[0]["FORGEJO_TOKEN"] != "" {
		t.Error("a placeholder token variable is not part of the minimal environment")
	}
}

func TestExecRunnerEnvironmentIsMinimal(t *testing.T) {
	t.Setenv("HOME", "/home/node-operator")
	rec := &execRec{out: "honoured"}
	r := &ExecRunner{Probes: map[string][]string{"hermes": {"/opt/p", "https://" + ProbeHost + "/"}}, Env: stationEnvFor("s"), Exec: rec.exec}
	if _, _, err := r.Run(context.Background(), "hermes"); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{"PATH": true, "HOME": true, "TMPDIR": true, "LANG": true, "HTTPS_PROXY": true, "https_proxy": true, "HTTP_PROXY": true, "http_proxy": true, "SSL_CERT_FILE": true, "CURL_CA_BUNDLE": true, "REQUESTS_CA_BUNDLE": true, "NODE_EXTRA_CA_CERTS": true, "NODE_USE_ENV_PROXY": true, "STK_BROKERED": true}
	for k, v := range envMap(rec.calls[0].env) {
		if !allowed[k] {
			t.Errorf("unexpected variable %s", k)
		}
		if k == "HOME" && v == "/home/node-operator" {
			t.Error("the node's home leaked into the probe")
		}
	}
}

func TestExecRunnerProbeReachesOnlyTheLocalFakeProvider(t *testing.T) {
	good := &execRec{out: "honoured"}
	r := &ExecRunner{Probes: map[string][]string{"hermes": {"/opt/p", "--url", "https://" + ProbeHost + "/x"}}, Env: stationEnvFor("s"), Exec: good.exec}
	if _, _, err := r.Run(context.Background(), "hermes"); err != nil {
		t.Fatal(err)
	}
	for _, a := range good.calls[0].argv {
		if strings.Contains(a, "://") && !strings.Contains(a, ProbeHost) {
			t.Errorf("argv names a non-fake host: %q", a)
		}
	}
	for _, e := range good.calls[0].env {
		if strings.Contains(e, "://") {
			_, v, _ := strings.Cut(e, "=")
			if !strings.Contains(v, "@127.0.0.1:") {
				t.Errorf("env names a non-local host: %q", e)
			}
		}
	}
	for name, argv := range map[string][]string{
		"real host": {"/opt/p", "https://forge.example.com/api/v1/user"},
		"public ip": {"/opt/p", "http://8.8.8.8/"},
		"lookalike": {"/opt/p", "https://" + ProbeHost + ".evil.com/"},
		"userinfo":  {"/opt/p", "https://" + ProbeHost + "@forge.example.com/"},
	} {
		rec := &execRec{out: "honoured"}
		rr := &ExecRunner{Probes: map[string][]string{"hermes": argv}, Env: stationEnvFor("s"), Exec: rec.exec}
		out, known, err := rr.Run(context.Background(), "hermes")
		if err == nil || out == "honoured" || !known || len(rec.calls) != 0 {
			t.Errorf("%s: ran or was believed: out=%q known=%v err=%v calls=%d", name, out, known, err, len(rec.calls))
		}
	}
	// a station whose proxy is not on this machine is refused too
	rec := &execRec{out: "honoured"}
	rr := &ExecRunner{Probes: map[string][]string{"hermes": {"/opt/p"}}, Env: func(context.Context) (map[string]string, error) {
		return map[string]string{"HTTPS_PROXY": "http://stk:K@proxy.corp.example:3128"}, nil
	}, Exec: rec.exec}
	if _, _, err := rr.Run(context.Background(), "hermes"); err == nil || len(rec.calls) != 0 {
		t.Fatalf("non-local proxy accepted: %v %d", err, len(rec.calls))
	}
}

func TestExecRunnerUnknownHarnessIsNotKnownAndExecFailuresAreErrors(t *testing.T) {
	rec := &execRec{}
	r := &ExecRunner{Probes: map[string][]string{"hermes": {"/opt/p"}}, Env: stationEnvFor("s"), Exec: rec.exec}
	if _, known, err := r.Run(context.Background(), "openclaw"); known || err != nil || len(rec.calls) != 0 {
		t.Fatalf("known=%v err=%v calls=%d", known, err, len(rec.calls))
	}
	rec.out, rec.err = "", errors.New("exit status 2")
	if _, known, err := r.Run(context.Background(), "hermes"); !known || err == nil {
		t.Fatalf("known=%v err=%v", known, err)
	}
	// no station env at all (the station holds no grant): nothing runs
	rec2 := &execRec{out: "honoured"}
	r2 := &ExecRunner{Probes: map[string][]string{"hermes": {"/opt/p"}}, Env: func(context.Context) (map[string]string, error) { return nil, nil }, Exec: rec2.exec}
	if _, _, err := r2.Run(context.Background(), "hermes"); err == nil || len(rec2.calls) != 0 {
		t.Fatalf("ran without a station env: %v %d", err, len(rec2.calls))
	}
}

func TestExecRunnerTimeoutIsAnError(t *testing.T) {
	r := &ExecRunner{Probes: map[string][]string{"hermes": {"/opt/p"}}, Env: stationEnvFor("s"), Timeout: 30 * time.Millisecond,
		Exec: func(ctx context.Context, _, _ []string) (string, error) { <-ctx.Done(); return "honoured", ctx.Err() }}
	out, _, err := r.Run(context.Background(), "hermes")
	if err == nil || out == "honoured" {
		t.Fatalf("out=%q err=%v", out, err)
	}
}

// ---- the verify ack ----

func (h *harness) verifyAck(t *testing.T) VerifyAck {
	t.Helper()
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	h.stub.verify = stkclient.VerifyResult{OK: true, Login: "agent-press"}
	ack, err := h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_1", GrantID: "fag_aaa111", ExpectLogin: "agent-press"})
	if err != nil {
		t.Fatal(err)
	}
	return ack
}

func TestBypassedClientMakesVerifyReportFailed(t *testing.T) {
	h := newHarness(t)
	h.stub.probe = []stkclient.ProbeOutcome{
		{Client: "curl", Outcome: "honoured"}, {Client: "node fetch", Outcome: "bypassed"},
	}
	h.svc.Bypass = func(ctx context.Context, c stkclient.Client) []ClientOutcome { return CheckBypass(ctx, c, "", nil) }
	ack := h.verifyAck(t)
	if ack.OK {
		t.Fatalf("a bypassing client left verify ok: %+v", ack)
	}
	// the hub reads the first token of reason (station-forge-api.ts): a stable word first
	if !strings.HasPrefix(ack.Reason, "bypassed:") || !strings.Contains(ack.Reason, "node fetch") {
		t.Errorf("reason = %q", ack.Reason)
	}
	if ack.Bypass == nil || outcomeOf(t, ack.Bypass.Clients, "node fetch") != "bypassed" {
		t.Errorf("the ack must carry the outcomes: %+v", ack.Bypass)
	}
	if ack.Login != "agent-press" {
		t.Error("stk's login must stay")
	}
}

func TestCleanProbeLeavesVerifyOKAndRefusedCAIsLoudButNotAFailure(t *testing.T) {
	h := newHarness(t)
	h.stub.probe = []stkclient.ProbeOutcome{{Client: "curl", Outcome: "honoured"}, {Client: "go net/http", Outcome: "refused-ca"}}
	h.svc.Bypass = func(ctx context.Context, c stkclient.Client) []ClientOutcome { return CheckBypass(ctx, c, "", nil) }
	ack := h.verifyAck(t)
	if !ack.OK || ack.Reason != "" {
		t.Fatalf("%+v", ack)
	}
	if outcomeOf(t, ack.Bypass.Clients, "go net/http") != "refused-ca" {
		t.Errorf("%+v", ack.Bypass)
	}
}

func TestBypassDoesNotMaskStksOwnFailure(t *testing.T) {
	h := newHarness(t)
	h.stub.probe = []stkclient.ProbeOutcome{{Client: "curl", Outcome: "bypassed"}}
	h.svc.Bypass = func(ctx context.Context, c stkclient.Client) []ClientOutcome { return CheckBypass(ctx, c, "", nil) }
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	h.stub.verify = stkclient.VerifyResult{OK: false, Reason: "unauthorized"}
	ack, _ := h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_1", GrantID: "fag_aaa111", ExpectLogin: "agent-press"})
	if ack.OK || !strings.HasPrefix(ack.Reason, "unauthorized") {
		t.Fatalf("stk's reason must stay first: %+v", ack)
	}
}

// ---- per station: the paths that are wired ----

func (fx *fixture) deliverKey(station, key, grant string) {
	fx.t.Helper()
	p := deliverParams(grant, "forge.example.com")
	p.StationID, p.StationKey = station, key
	p.Sealed = Sealed(HandoverPrefix + "SEALED-" + station + "-" + grant + "-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if _, err := fx.m.Deliver(context.Background(), p); err != nil {
		fx.t.Fatal(err)
	}
}

func (fx *fixture) verify(station, grant string, probe ...stkclient.ProbeOutcome) VerifyAck {
	fx.t.Helper()
	s := fx.stub(station)
	s.verify = stkclient.VerifyResult{OK: true, Login: "agent-press"}
	s.probe = probe
	ack, err := fx.m.Verify(context.Background(), VerifyParams{StationID: station, GrantID: grant, ExpectLogin: "agent-press"})
	if err != nil {
		fx.t.Fatal(err)
	}
	return ack
}

func pathOf(t *testing.T, r *BypassReport, name string) BypassPath {
	t.Helper()
	for _, p := range r.Paths {
		if p.Path == name {
			return p
		}
	}
	t.Fatalf("no path %q in %+v", name, r.Paths)
	return BypassPath{}
}

var honouredCurl = stkclient.ProbeOutcome{Client: "curl", Outcome: "honoured"}

func TestVerifyAckSaysWhichHarnessPathsAreWired(t *testing.T) {
	fx, _ := newWiringFixture(t)
	fx.deliverKey("stn_1", "hermes:stn_1", "fag_aaa111")
	ack := fx.verify("stn_1", "fag_aaa111", honouredCurl)
	if !ack.OK || ack.Bypass == nil {
		t.Fatalf("%+v", ack)
	}
	r := ack.Bypass
	if !pathOf(t, r, "spawn").Wired || !pathOf(t, r, "gateway").Wired || len(pathOf(t, r, "gateway").Units) != 1 || !r.Brokered || r.WiringBlocked != "" {
		t.Fatalf("%+v", r)
	}
	if r.Harness != "hermes" {
		t.Errorf("harness = %q", r.Harness)
	}
}

func TestAnUnwiredGatewayPathIsNeverClaimedBrokered(t *testing.T) {
	// openclaw's single gateway serves several stations; a hermes station with no per-station
	// unit is the root gateway
	for _, key := range []string{"openclaw:stn_1", "hermes:stn_1"} {
		t.Run(key, func(t *testing.T) {
			fx, _ := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) {
				c.Harness.Units = func(string) []string { return nil }
			})
			fx.deliverKey("stn_1", key, "fag_aaa111")
			ack := fx.verify("stn_1", "fag_aaa111", honouredCurl)
			r := ack.Bypass
			g := pathOf(t, r, "gateway")
			if g.Wired || g.Reason == "" || r.Brokered {
				t.Fatalf("gateway claimed brokered: %+v", r)
			}
			// the spawn path is wired, so the credential still verifies
			if !ack.OK || !pathOf(t, r, "spawn").Wired {
				t.Fatalf("%+v", ack)
			}
			for _, c := range r.Clients {
				if c.Client == r.Harness && c.Outcome == "honoured" {
					t.Error("an unwired harness was reported honoured")
				}
			}
		})
	}
}

func TestWiringBlockedPropagatesToTheAckAndNoPathMeansNotOK(t *testing.T) {
	fx, w := newWiringFixture(t)
	w.mu.Lock()
	w.unitEnv = []string{"https_proxy=http://corp:SECRETPW@proxy:3128"}
	w.mu.Unlock()
	fx.deliverKey("stn_1", "hermes:stn_1", "fag_aaa111")
	fx.m.NoteBlocked("hermes:stn_1", []string{"HTTPS_PROXY"})
	ack := fx.verify("stn_1", "fag_aaa111", honouredCurl)
	r := ack.Bypass
	if !strings.Contains(r.WiringBlocked, "https_proxy") || !strings.Contains(r.WiringBlocked, "HTTPS_PROXY") || strings.Contains(r.WiringBlocked, "SECRETPW") {
		t.Fatalf("wiringBlocked = %q", r.WiringBlocked)
	}
	if r.Brokered || pathOf(t, r, "spawn").Wired || pathOf(t, r, "gateway").Wired {
		t.Fatalf("blocked paths claimed wired: %+v", r)
	}
	// generic clients honoured, but the station's harness reaches the forge by no brokered path
	if ack.OK || !strings.HasPrefix(ack.Reason, "not-wired:") {
		t.Fatalf("verify must not be ok with no wired path: %+v", ack)
	}
	if ack.Login != "agent-press" {
		t.Error("stk's login must stay")
	}
}

func TestStationWithoutHarnessWiringConfiguredIsNotWired(t *testing.T) {
	fx := newFixture(t)
	fx.deliverKey("stn_1", "hermes:stn_1", "fag_aaa111")
	ack := fx.verify("stn_1", "fag_aaa111", honouredCurl)
	if ack.OK || !strings.HasPrefix(ack.Reason, "not-wired:") || ack.Bypass.Brokered {
		t.Fatalf("%+v %+v", ack, ack.Bypass)
	}
}

func TestInstancesVerifyRunsTheHarnessProbeOnlyForAWiredPathAndOnlyUnderThatStation(t *testing.T) {
	var calls []string
	var mu sync.Mutex
	fx, _ := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) {
		c.HarnessProbes = map[string][]string{"hermes": {"/opt/p", "https://" + ProbeHost + "/"}}
		c.ProbeExec = func(_ context.Context, argv, env []string) (string, error) {
			mu.Lock()
			calls = append(calls, strings.Join(env, " "))
			mu.Unlock()
			return "honoured", nil
		}
	})
	fx.deliverKey("stn_1", "hermes:stn_1", "fag_aaa111")
	fx.deliverKey("stn_2", "hermes:stn_2", "fag_bbb222")
	a1 := fx.verify("stn_1", "fag_aaa111", honouredCurl)
	a2 := fx.verify("stn_2", "fag_bbb222", honouredCurl)
	if outcomeOf(t, a1.Bypass.Clients, "hermes") != "honoured" || outcomeOf(t, a2.Bypass.Clients, "hermes") != "honoured" {
		t.Fatalf("%+v %+v", a1.Bypass, a2.Bypass)
	}
	if len(calls) != 2 || strings.Contains(calls[0], "stk-stn-2") || strings.Contains(calls[1], "stk-stn-1") {
		t.Fatalf("env bled across stations: %v", calls)
	}
	i1, _ := fx.m.Instance("stn_1")
	i2, _ := fx.m.Instance("stn_2")
	if !strings.Contains(calls[0], "KEY-"+i1.Name) || !strings.Contains(calls[1], "KEY-"+i2.Name) {
		t.Fatalf("each probe must run under its own station's key: %v", calls)
	}
}

func TestInstancesNeverRunTheHarnessProbeWhenNoPathIsWired(t *testing.T) {
	ran := false
	fx, w := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) {
		c.HarnessProbes = map[string][]string{"hermes": {"/opt/p"}}
		c.ProbeExec = func(context.Context, []string, []string) (string, error) { ran = true; return "honoured", nil }
	})
	w.mu.Lock()
	w.unitEnv = []string{"https_proxy=http://corp:3128"}
	w.mu.Unlock()
	fx.deliverKey("stn_1", "hermes:stn_1", "fag_aaa111")
	fx.m.NoteBlocked("hermes:stn_1", []string{"HTTPS_PROXY"})
	ack := fx.verify("stn_1", "fag_aaa111", honouredCurl)
	if ran || outcomeOf(t, ack.Bypass.Clients, "hermes") != "untested" {
		t.Fatalf("ran=%v %+v", ran, ack.Bypass)
	}
}

func TestBypassedHarnessClientFailsVerifyThroughTheInstances(t *testing.T) {
	fx, _ := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) {
		c.HarnessProbes = map[string][]string{"hermes": {"/opt/p"}}
		c.ProbeExec = func(context.Context, []string, []string) (string, error) { return "bypassed", nil }
	})
	fx.deliverKey("stn_1", "hermes:stn_1", "fag_aaa111")
	ack := fx.verify("stn_1", "fag_aaa111", honouredCurl)
	if ack.OK || !strings.HasPrefix(ack.Reason, "bypassed:") || !strings.Contains(ack.Reason, "hermes") {
		t.Fatalf("%+v", ack)
	}
}
