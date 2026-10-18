package forgeapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// realSecret has the shape of a sealed envelope carrying a Forgejo token. No assertion below may
// find any of it anywhere but in the call to HandoverOpen.
const realSecret = "stk-handover-v1:c2VhbGVkLXRva2VuLWYwcmdlai0wMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZg=="
const secretBody = "c2VhbGVkLXRva2VuLWYwcmdlai0wMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZg"

// brokerStub is a stkclient.Client that records calls and lets a test fail any of them. Its
// Reload plays the part of stk's strict loader through onReload, which sees the policy file as
// stk would at that moment.
type brokerStub struct {
	stkclient.Client // nil: an unscripted method panics loudly

	mu         sync.Mutex
	calls      []string
	envelopes  map[string]string // service -> envelope received on stdin
	openErr    error
	reloadErr  error
	revokeErr  error
	keyErr     error
	verify     stkclient.VerifyResult
	verifyErr  error
	policyPath string
	onReload   func(policy []byte) error
	onRevoke   func() error
	onOpen     func() // runs inside HandoverOpen, before it returns
	probe      []stkclient.ProbeOutcome
	probeErr   error
	probes     int
}

func (b *brokerStub) Probe(context.Context) ([]stkclient.ProbeOutcome, error) {
	b.mu.Lock()
	b.probes++
	b.mu.Unlock()
	return append([]stkclient.ProbeOutcome(nil), b.probe...), b.probeErr
}

func (b *brokerStub) rec(s string) {
	b.mu.Lock()
	b.calls = append(b.calls, s)
	b.mu.Unlock()
}

func (b *brokerStub) callList() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.calls...)
}

func (b *brokerStub) Version(context.Context) (string, error) { return "0.0.3", nil }

func (b *brokerStub) HandoverKey(context.Context) (string, error) {
	b.rec("key")
	if b.keyErr != nil {
		return "", b.keyErr
	}
	return "stk-handover-v1:PUBLICKEY", nil
}

func (b *brokerStub) HandoverOpen(_ context.Context, service, envelope string) error {
	b.rec("open:" + service)
	if b.onOpen != nil {
		b.onOpen()
	}
	b.mu.Lock()
	if b.envelopes == nil {
		b.envelopes = map[string]string{}
	}
	b.envelopes[service] = envelope
	b.mu.Unlock()
	return b.openErr
}

func (b *brokerStub) Reload(context.Context) (stkclient.ReloadResult, error) {
	b.rec("reload")
	if b.reloadErr != nil {
		return stkclient.ReloadResult{}, b.reloadErr
	}
	if b.onReload != nil {
		data, _ := os.ReadFile(b.policyPath)
		if err := b.onReload(data); err != nil {
			return stkclient.ReloadResult{OK: false, Error: err.Error()}, &stkclient.ReloadRejectedError{Reason: err.Error()}
		}
	}
	return stkclient.ReloadResult{OK: true}, nil
}

func (b *brokerStub) RevokeLocal(_ context.Context, service string) error {
	b.rec("revoke:" + service)
	if b.onRevoke != nil {
		return b.onRevoke()
	}
	return b.revokeErr
}

func (b *brokerStub) Verify(_ context.Context, service, login string) (stkclient.VerifyResult, error) {
	b.rec("verify:" + service + ":" + login)
	return b.verify, b.verifyErr
}

// harness wires a Service to a stub and a temp policy file.
type harness struct {
	t    *testing.T
	svc  *Service
	stub *brokerStub
	path string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	oldLog := logf
	logf = func(string, ...any) {}
	t.Cleanup(func() { logf = oldLog })
	dir := t.TempDir()
	path := filepath.Join(dir, "supertoolkit.yaml")
	stub := &brokerStub{policyPath: path}
	h := &harness{t: t, stub: stub, path: path}
	h.svc = &Service{
		Ensure: func(context.Context) (SetupResult, error) {
			return SetupResult{Report: rep(LevelSeparateUser)}, nil
		},
		NewClient:  func() stkclient.Client { return stub },
		PolicyPath: path,
	}
	return h
}

func (h *harness) policy() []byte {
	h.t.Helper()
	b, err := os.ReadFile(h.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		h.t.Fatal(err)
	}
	return b
}

// seedOtherStation writes a managed entry labelled with another station straight into the file
// (a leftover; a station's own file should never hold one).
func (h *harness) seedOtherStation(grant, host, station string) {
	h.t.Helper()
	e := baseEntry()
	e.Service, e.Grant, e.Station, e.Instance = "forge-forgejo-"+strings.TrimPrefix(grant, "fag_"), grant, station, "https://"+host
	out, err := MergePolicy(h.policy(), e)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(h.path, out, 0o640); err != nil {
		h.t.Fatal(err)
	}
}

func deliverParams(grant, host string) DeliverParams {
	return DeliverParams{
		StationID: "stn_1", StationKey: "hermes:press", GrantID: grant, Provider: "forgejo",
		Instance: "https://" + host, Mode: "minted", ServiceName: "forge-forgejo-" + strings.TrimPrefix(grant, "fag_"),
		Repositories: []string{"acme/widgets"}, Preset: "read", Rules: []Rule{},
		AllowGraphql: false, Sealed: Sealed(realSecret), ExpectLogin: "agent-press",
	}
}

func TestDeliverWritesEntryOpensEnvelopeReloadsAcksStored(t *testing.T) {
	h := newHarness(t)
	ack, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com"))
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if !ack.OK || !ack.Stored || ack.Isolation != "separate-user" {
		t.Fatalf("ack = %+v, want ok, stored, separate-user", ack)
	}
	if got, want := strings.Join(h.stub.callList(), ","), "open:forge-forgejo-aaa111,reload"; got != want {
		t.Fatalf("stk calls = %s, want %s (open the envelope, then reload)", got, want)
	}
	if h.stub.envelopes["forge-forgejo-aaa111"] != realSecret {
		t.Fatal("the envelope did not reach HandoverOpen intact")
	}
	p := string(h.policy())
	for _, want := range []string{
		"forge-forgejo-aaa111:", "kind: forge", "provider: forgejo", "host: forge.example.com",
		"scheme: token", "auth: token", "env_var: FORGEJO_TOKEN", "preset: read", "acme/widgets",
		"grant: fag_aaa111", "station: stn_1",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("policy file missing %q:\n%s", want, p)
		}
	}
}

func TestDeliverReplayIsIdempotent(t *testing.T) {
	h := newHarness(t)
	p := deliverParams("fag_aaa111", "forge.example.com")
	if _, err := h.svc.Deliver(t.Context(), p); err != nil {
		t.Fatal(err)
	}
	first := h.policy()
	ack, err := h.svc.Deliver(t.Context(), p)
	if err != nil || !ack.OK || !ack.Stored {
		t.Fatalf("replay = %+v, %v", ack, err)
	}
	if !bytes.Equal(first, h.policy()) {
		t.Fatalf("a replay changed the policy file:\n%s\n---\n%s", first, h.policy())
	}
	if n := strings.Count(strings.Join(h.stub.callList(), ","), "open:"); n != 2 {
		t.Fatalf("handover opened %d times, want 2 (a replay re-opens the envelope)", n)
	}
}

func TestDeliverWithNoStkIsAnErrorNeverSuccess(t *testing.T) {
	h := newHarness(t)
	h.svc.Ensure = func(context.Context) (SetupResult, error) {
		return SetupResult{}, fmt.Errorf("stk not found: %w", stkclient.ErrStkMissing)
	}
	ack, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com"))
	if err == nil {
		t.Fatalf("Deliver with no stk succeeded: %+v", ack)
	}
	if !strings.HasPrefix(err.Error(), "stk-missing:") {
		t.Errorf("error = %q, want the stk-missing code first", err)
	}
	if ack.OK || ack.Stored {
		t.Errorf("ack = %+v, must not claim anything", ack)
	}
	if len(h.stub.callList()) != 0 || h.policy() != nil {
		t.Errorf("nothing may be written or called without stk: calls %v", h.stub.callList())
	}
}

// The operator's own file, with a comment and a key the node does not know.
const operatorFile = `# operator policy - keep
workspace: demo
agent_uids: [1001]
services:
  # the operator's Slack
  slack:
    capabilities:
      post: agent
`

func TestDeliverRejectedReloadRollsBackByteForByte(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(h.path, []byte(operatorFile), 0o640); err != nil {
		t.Fatal(err)
	}
	h.stub.onReload = func(policy []byte) error {
		if bytes.Contains(policy, []byte("forge-forgejo-aaa111")) {
			return errors.New("service forge-forgejo-aaa111 rule user#1: unknown pattern")
		}
		return nil
	}
	ack, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com"))
	if err == nil || ack.OK || ack.Stored {
		t.Fatalf("a rejected reload must not be success: %+v, %v", ack, err)
	}
	if !strings.HasPrefix(err.Error(), "reload-rejected:") {
		t.Errorf("error = %q, want reload-rejected first", err)
	}
	if got := string(h.policy()); got != operatorFile {
		t.Fatalf("policy file was not restored byte for byte:\n%s", got)
	}
	if !strings.Contains(strings.Join(h.stub.callList(), ","), "revoke:forge-forgejo-aaa111") {
		t.Errorf("the credential stored for a refused new entry should be forgotten: %v", h.stub.callList())
	}
}

func TestDeliverRejectedReloadWithNoPriorFileLeavesNoFile(t *testing.T) {
	h := newHarness(t)
	h.stub.reloadErr = &stkclient.ReloadRejectedError{Reason: "no"}
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err == nil {
		t.Fatal("want an error")
	}
	if _, err := os.Stat(h.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a file the node created for a refused entry must be removed: %v", err)
	}
}

func TestDeliverHandoverFailureLeavesNoDanglingEntry(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(h.path, []byte(operatorFile), 0o640); err != nil {
		t.Fatal(err)
	}
	h.stub.openErr = errors.New("stk handover open: bad envelope")
	_, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com"))
	if err == nil || !strings.HasPrefix(err.Error(), "handover-failed:") {
		t.Fatalf("err = %v, want handover-failed", err)
	}
	if got := string(h.policy()); got != operatorFile {
		t.Fatalf("a failed handover left an entry behind:\n%s", got)
	}
	if strings.Contains(strings.Join(h.stub.callList(), ","), "reload") {
		t.Error("must not reload after a failed handover")
	}
}

func TestDeliverHandoverFailureKeepsAnEntryThatAlreadyExisted(t *testing.T) {
	h := newHarness(t)
	p := deliverParams("fag_aaa111", "forge.example.com")
	if _, err := h.svc.Deliver(t.Context(), p); err != nil {
		t.Fatal(err)
	}
	before := h.policy()
	h.stub.openErr = errors.New("boom")
	p.Preset = "issues"
	if _, err := h.svc.Deliver(t.Context(), p); err == nil {
		t.Fatal("want an error")
	}
	if !bytes.Equal(before, h.policy()) {
		t.Fatal("the pre-existing entry must be exactly as it was")
	}
}

func TestNoTokenAnywhereButTheHandoverCall(t *testing.T) {
	var logs bytes.Buffer
	old := logf
	logf = func(f string, a ...any) { log.New(&logs, "", 0).Printf(f, a...) }
	defer func() { logf = old }()

	h := newHarness(t)
	p := deliverParams("fag_aaa111", "forge.example.com")
	ack, err := h.svc.Deliver(t.Context(), p)
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := json.Marshal(ack)
	// Failure paths carry errors too.
	h.stub.openErr = errors.New("stk handover open: failed")
	_, ferr := h.svc.Deliver(t.Context(), p)
	h.stub.openErr = nil
	h.stub.reloadErr = &stkclient.ReloadRejectedError{Reason: "bad"}
	_, rerr := h.svc.Deliver(t.Context(), p)

	for name, blob := range map[string]string{
		"ack": string(wire), "policy file": string(h.policy()), "log": logs.String(),
		"handover error": ferr.Error(), "reload error": rerr.Error(),
		"fmt %v": fmt.Sprintf("%v", p), "fmt %+v": fmt.Sprintf("%+v", p), "fmt %#v": fmt.Sprintf("%#v", p),
	} {
		if strings.Contains(blob, secretBody) || strings.Contains(blob, "stk-handover-v1:c2Vh") {
			t.Errorf("%s contains the sealed credential: %s", name, blob)
		}
	}
	if h.stub.envelopes["forge-forgejo-aaa111"] != realSecret {
		t.Fatal("test is vacuous: the envelope never reached the stub")
	}
}

func TestDeliverRejectsAMalformedEnvelopeBeforeDoingAnything(t *testing.T) {
	h := newHarness(t)
	for _, sealed := range []string{"", "plaintext-token", HandoverPrefix, HandoverPrefix + strings.Repeat("a", SealedMax)} {
		p := deliverParams("fag_aaa111", "forge.example.com")
		p.Sealed = Sealed(sealed)
		if _, err := h.svc.Deliver(t.Context(), p); err == nil || !strings.HasPrefix(err.Error(), "invalid-params:") {
			t.Errorf("sealed %.20q: err = %v, want invalid-params", sealed, err)
		}
	}
	if len(h.stub.callList()) != 0 || h.policy() != nil {
		t.Fatal("a malformed frame must change nothing")
	}
}

func TestDeliverReportsDegradedIsolationHonestly(t *testing.T) {
	h := newHarness(t)
	h.svc.Ensure = func(context.Context) (SetupResult, error) {
		return SetupResult{Report: rep("same-user"), Degraded: true, Reason: "not running as root"}, nil
	}
	ack, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com"))
	if err != nil || !ack.OK || ack.Isolation != "same-user" || ack.Reason == "" {
		t.Fatalf("ack = %+v, %v; want ok with same-user and a reason", ack, err)
	}
	// stk says separate-user but an agent runs as root: not protected, not reported as protected.
	h.svc.Ensure = func(context.Context) (SetupResult, error) {
		return SetupResult{Report: rep(LevelSeparateUser), Degraded: true, Reason: reasonRootAgent}, nil
	}
	ack, _ = h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com"))
	if ack.Isolation != "same-user" {
		t.Fatalf("isolation = %q for a root agent, want same-user", ack.Isolation)
	}
}

func TestPolicyFileIsNeverWorldReadable(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(h.path)
	if st.Mode().Perm() != 0o640 {
		t.Fatalf("new file mode = %o, want 640", st.Mode().Perm())
	}
	// An operator file that was world-readable is tightened, not preserved.
	if err := os.Chmod(h.path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_bbb222", "other.example.com")); err != nil {
		t.Fatal(err)
	}
	st, _ = os.Stat(h.path)
	if st.Mode().Perm()&0o007 != 0 {
		t.Fatalf("mode = %o, world bits set", st.Mode().Perm())
	}
	// And no temp file is left behind.
	ents, _ := os.ReadDir(filepath.Dir(h.path))
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("leftover temp file %s", e.Name())
		}
	}
}

func TestRevokeRemovesEntryAndCredentialAndIsIdempotent(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(h.path, []byte(operatorFile), 0o640); err != nil {
		t.Fatal(err)
	}
	var unwired []string
	h.svc.Unwire = func(g string) error { unwired = append(unwired, g); return nil }
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	h.stub.calls = nil

	ack, err := h.svc.Revoke(t.Context(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"})
	if err != nil || !ack.Removed {
		t.Fatalf("Revoke = %+v, %v", ack, err)
	}
	if got, want := strings.Join(h.stub.callList(), ","), "revoke:forge-forgejo-aaa111,reload"; got != want {
		t.Fatalf("calls = %s, want %s (wipe the credential first, then the entry, then reload)", got, want)
	}
	p := string(h.policy())
	if strings.Contains(p, "forge-forgejo-aaa111") {
		t.Fatalf("entry still in the policy:\n%s", p)
	}
	if !strings.Contains(p, "slack:") || !strings.Contains(p, "workspace: demo") || !strings.Contains(p, "# the operator's Slack") {
		t.Fatalf("revoke damaged operator content:\n%s", p)
	}
	if len(unwired) != 1 || unwired[0] != "fag_aaa111" {
		t.Fatalf("unwire calls = %v", unwired)
	}
	// Again: nothing to remove, still success, and the wiring is cleaned again.
	h.stub.calls = nil
	ack, err = h.svc.Revoke(t.Context(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"})
	if err != nil || ack.Removed {
		t.Fatalf("second Revoke = %+v, %v; want ok, removed=false", ack, err)
	}
	if len(h.stub.callList()) != 0 {
		t.Errorf("an absent grant must not call stk: %v", h.stub.callList())
	}
	if len(unwired) != 2 {
		t.Errorf("unwire should still run for an absent grant, calls = %v", unwired)
	}
}

func TestRevokeOfAnUnknownGrantSucceeds(t *testing.T) {
	h := newHarness(t) // no policy file at all
	ack, err := h.svc.Revoke(t.Context(), RevokeParams{StationID: "stn_1", GrantID: "fag_nope"})
	if err != nil || ack.Removed {
		t.Fatalf("Revoke = %+v, %v", ack, err)
	}
}

func TestRevokeToleratesACredentialAlreadyGone(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	h.stub.revokeErr = errors.New("stk revoke failed: forge-forgejo-aaa111 is not connected here, so there is nothing to withdraw")
	if ack, err := h.svc.Revoke(t.Context(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"}); err != nil || !ack.Removed {
		t.Fatalf("Revoke = %+v, %v; a credential already gone is a clean revoke", ack, err)
	}
	if strings.Contains(string(h.policy()), "forge-forgejo-aaa111") {
		t.Fatal("entry should be gone")
	}
}

func TestRevokeFailureLeavesTheEntryForARetry(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	before := h.policy()
	h.stub.revokeErr = errors.New("stk revoke failed: exit 1")
	if _, err := h.svc.Revoke(t.Context(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"}); err == nil {
		t.Fatal("a failed wipe must not be reported as revoked")
	}
	if !bytes.Equal(before, h.policy()) {
		t.Fatal("the entry must stay so the hub's retry finds it")
	}
}

func TestPolicyReplacesRulesAndReloads(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	h.stub.calls = nil
	ack, err := h.svc.Policy(t.Context(), PolicyParams{
		StationID: "stn_1", GrantID: "fag_aaa111", Preset: "issues", AllowGraphql: true,
		Rules: []Rule{{Deny: "DELETE /repos/{owner}/{repo}/issues/*"}, {Allow: "POST /x", When: map[string]any{"state": "closed"}}},
	})
	if err != nil || !ack.OK {
		t.Fatalf("Policy = %+v, %v", ack, err)
	}
	if got := strings.Join(h.stub.callList(), ","); got != "reload" {
		t.Fatalf("calls = %s, want a single reload (no new credential)", got)
	}
	p := string(h.policy())
	for _, want := range []string{"preset: issues", "allow_graphql: true", "deny: DELETE /repos/{owner}/{repo}/issues/*", "state: closed", "grant: fag_aaa111", "acme/widgets"} {
		if !strings.Contains(p, want) {
			t.Errorf("policy missing %q:\n%s", want, p)
		}
	}
	// Dropping every rule removes the key rather than leaving an empty list.
	if ack, _ := h.svc.Policy(t.Context(), PolicyParams{StationID: "stn_1", GrantID: "fag_aaa111", Preset: "read"}); !ack.OK {
		t.Fatalf("Policy = %+v", ack)
	}
	if strings.Contains(string(h.policy()), "rules:") {
		t.Fatalf("rules key should be gone:\n%s", h.policy())
	}
}

func TestPolicyForAnUnknownGrantIsUnknownGrant(t *testing.T) {
	h := newHarness(t)
	ack, err := h.svc.Policy(t.Context(), PolicyParams{StationID: "stn_1", GrantID: "fag_nope", Preset: "read"})
	if err != nil || ack.OK || ack.Error != "unknown-grant" {
		t.Fatalf("Policy = %+v, %v; want ok:false unknown-grant", ack, err)
	}
	if len(h.stub.callList()) != 0 {
		t.Fatal("must not reload for an unknown grant")
	}
}

func TestPolicyRejectedReloadRollsBack(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	before := h.policy()
	h.stub.onReload = func(policy []byte) error {
		if bytes.Contains(policy, []byte("BADPATTERN")) {
			return errors.New("rule user#1: bad pattern")
		}
		return nil
	}
	ack, err := h.svc.Policy(t.Context(), PolicyParams{StationID: "stn_1", GrantID: "fag_aaa111", Preset: "read", Rules: []Rule{{Allow: "BADPATTERN"}}})
	if err != nil || ack.OK || !strings.HasPrefix(ack.Error, "reload-rejected:") {
		t.Fatalf("Policy = %+v, %v; want ok:false reload-rejected", ack, err)
	}
	if !bytes.Equal(before, h.policy()) {
		t.Fatalf("policy file not restored:\n%s", h.policy())
	}
}

func TestPolicyRejectsABadPresetOrRule(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	for _, p := range []PolicyParams{
		{StationID: "stn_1", GrantID: "fag_aaa111", Preset: "admin"},
		{StationID: "stn_1", GrantID: "fag_aaa111", Preset: "read", Rules: []Rule{{Allow: "a", Deny: "b"}}},
		{StationID: "stn_1", GrantID: "fag_aaa111", Preset: "read", Rules: []Rule{{}}},
	} {
		if ack, _ := h.svc.Policy(t.Context(), p); ack.OK {
			t.Errorf("Policy %+v succeeded", p)
		}
	}
}

func TestStatusReturnsPublicKeyEvenWithZeroGrants(t *testing.T) {
	h := newHarness(t)
	ack, err := h.svc.Status(t.Context(), StatusParams{StationID: "stn_1"})
	if err != nil {
		t.Fatal(err)
	}
	if ack.PublicKey == "" || ack.PublicKey != "stk-handover-v1:PUBLICKEY" {
		t.Fatalf("publicKey = %q", ack.PublicKey)
	}
	if ack.Grants == nil {
		t.Fatal("grants must be an empty array, not null (the contract requires an array)")
	}
	wire, _ := json.Marshal(ack)
	if !strings.Contains(string(wire), `"grants":[]`) {
		t.Fatalf("wire = %s", wire)
	}
}

func TestStatusListsOnlyThisStationsGrants(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	h.seedOtherStation("fag_bbb222", "other.example.com", "stn_2")
	ack, err := h.svc.Status(t.Context(), StatusParams{StationID: "stn_1"})
	if err != nil || len(ack.Grants) != 1 || ack.Grants[0].GrantID != "fag_aaa111" || !ack.Grants[0].Present || ack.Grants[0].Isolation != "separate-user" {
		t.Fatalf("Status = %+v, %v", ack, err)
	}
	if ack.StkVersion != "0.0.3" {
		t.Errorf("stkVersion = %q", ack.StkVersion)
	}
}

func TestStatusErrorsCleanlyWhenTheKeyCannotBeRead(t *testing.T) {
	h := newHarness(t)
	h.stub.keyErr = errors.New("stk handover key: failed")
	ack, err := h.svc.Status(t.Context(), StatusParams{StationID: "stn_1"})
	if err == nil || !strings.HasPrefix(err.Error(), "handover-key-failed:") {
		t.Fatalf("Status = %+v, %v; want handover-key-failed", ack, err)
	}
	if ack.PublicKey != "" {
		t.Fatal("a stale or empty key must not be returned beside an error")
	}
}

func TestVerifyPassesStkReasonCodesUnchanged(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	reasons := []string{"unauthorized", "forbidden", "unreachable", "unexpected-response", "server-error", "redirect", "wrong-identity", "repository-missing", "unsupported"}
	for _, r := range reasons {
		h.stub.verify = stkclient.VerifyResult{OK: false, Reason: r}
		ack, err := h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_1", GrantID: "fag_aaa111", ExpectLogin: "agent-press"})
		if err != nil || ack.OK || ack.Reason != r || ack.Isolation != "separate-user" {
			t.Errorf("reason %s: ack = %+v, %v", r, ack, err)
		}
	}
	h.stub.verify = stkclient.VerifyResult{OK: true, Login: "agent-press"}
	ack, err := h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_1", GrantID: "fag_aaa111", ExpectLogin: "agent-press"})
	if err != nil || !ack.OK || ack.Login != "agent-press" || ack.Reason != "" {
		t.Fatalf("ok ack = %+v, %v", ack, err)
	}
	if !strings.Contains(strings.Join(h.stub.callList(), ","), "verify:forge-forgejo-aaa111:agent-press") {
		t.Errorf("verify must name the grant's service and the expected login: %v", h.stub.callList())
	}
}

// stk exits non-zero on a failed verification but still prints the JSON. The ack must be built
// from that JSON, not from the exit code.
func TestVerifyBuildsAStructuredAckFromANonZeroStkExit(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	run := func(_ context.Context, _ string, args []string, _ []byte, _ []string) ([]byte, []byte, int, error) {
		if len(args) > 0 && args[0] == "verify" {
			return []byte(`{"ok":false,"reason":"wrong-identity: the forge answered as someone-else"}`), nil, 1, nil
		}
		return nil, nil, 0, nil
	}
	h.svc.NewClient = func() stkclient.Client { return stkclient.New("stk", stkclient.Options{Run: run}) }
	ack, err := h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_1", GrantID: "fag_aaa111", ExpectLogin: "agent-press"})
	if err != nil || ack.OK || !strings.HasPrefix(ack.Reason, "wrong-identity") {
		t.Fatalf("ack = %+v, %v; want ok:false with stk's reason", ack, err)
	}
}

func TestVerifyOfAnUnknownGrantIsAnError(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_1", GrantID: "fag_nope", ExpectLogin: "x"}); err == nil || !strings.HasPrefix(err.Error(), "unknown-grant:") {
		t.Fatalf("err = %v, want unknown-grant", err)
	}
}

func TestVerifyBypassHookRidesInTheAck(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	h.stub.verify = stkclient.VerifyResult{OK: true, Login: "agent-press"}
	ack, _ := h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_1", GrantID: "fag_aaa111", ExpectLogin: "agent-press"})
	if ack.Bypass != nil {
		t.Fatal("no hook, no bypass field")
	}
	h.svc.Bypass = func(context.Context, stkclient.Client) []ClientOutcome {
		return []ClientOutcome{{Client: "curl", Outcome: "honoured"}}
	}
	ack, _ = h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_1", GrantID: "fag_aaa111", ExpectLogin: "agent-press"})
	if ack.Bypass == nil {
		t.Fatal("hook result missing")
	}
}

func TestSecondGrantOnAProviderGetsADerivedEnvVarAndKeepsItOnReplay(t *testing.T) {
	h := newHarness(t)
	a := deliverParams("fag_aaa111", "a.example.com")
	b := deliverParams("fag_bbb22222cc", "b.example.com")
	for _, p := range []DeliverParams{a, b} {
		if _, err := h.svc.Deliver(t.Context(), p); err != nil {
			t.Fatal(err)
		}
	}
	p := string(h.policy())
	if strings.Count(p, "env_var: FORGEJO_TOKEN") != 1 || !strings.Contains(p, "env_var: AGENTPOD_FORGE_BBB22222_TOKEN") {
		t.Fatalf("env vars wrong:\n%s", p)
	}
	before := h.policy()
	for _, q := range []DeliverParams{b, a} {
		if _, err := h.svc.Deliver(t.Context(), q); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(before, h.policy()) {
		t.Fatal("replaying either grant changed the file")
	}
}

func TestConcurrentDeliverAndRevokeLeaveAConsistentFile(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(h.path, []byte(operatorFile), 0o640); err != nil {
		t.Fatal(err)
	}
	const n = 16
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			g := fmt.Sprintf("fag_g%02d%02d%02d", i, i, i)
			p := deliverParams(g, fmt.Sprintf("h%d.example.com", i))
			p.ServiceName = fmt.Sprintf("forge-forgejo-g%02d%02d%02d", i, i, i)
			if _, err := h.svc.Deliver(t.Context(), p); err != nil {
				t.Errorf("deliver %d: %v", i, err)
				return
			}
			if i%2 == 0 {
				if _, err := h.svc.Revoke(t.Context(), RevokeParams{StationID: "stn_1", GrantID: g}); err != nil {
					t.Errorf("revoke %d: %v", i, err)
				}
			}
		}(i)
	}
	wg.Wait()
	all, err := ManagedEntries(h.policy())
	if err != nil {
		t.Fatalf("file is not valid: %v", err)
	}
	if len(all) != n/2 {
		t.Fatalf("%d entries, want %d (every odd grant survives):\n%s", len(all), n/2, h.policy())
	}
	if !strings.Contains(string(h.policy()), "slack:") {
		t.Fatal("operator entry lost")
	}
}

// ---- review fix round 1 ----

// stk resolves a service through the policy, so forgetting a refused entry's credential only
// works while the entry is still in the file.
func TestRefusedNewEntryIsForgottenBeforeThePolicyIsRestored(t *testing.T) {
	h := newHarness(t)
	h.stub.reloadErr = &stkclient.ReloadRejectedError{Reason: "no"}
	var forgotten bool
	h.stub.onRevoke = func() error {
		if !bytes.Contains(h.policy(), []byte("forge-forgejo-aaa111")) {
			return errors.New("unknown service")
		}
		forgotten = true
		return nil
	}
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "a.example.com")); err == nil {
		t.Fatal("want error")
	}
	if !forgotten {
		t.Fatal("credential was not forgotten while the entry was still in the policy")
	}
	if h.policy() != nil {
		t.Fatal("policy not restored")
	}
}

// The hub must read a reason, promptly, for each way stk can be unusable: a verb the node cannot
// serve is an error ack, never a timeout.
func TestVerbsAnswerErrorAcksWhenUnavailableNotTimeouts(t *testing.T) {
	reasons := []struct {
		name string
		err  error
		code string
	}{
		{"missing", fmt.Errorf("stk not found: %w", stkclient.ErrStkMissing), "stk-missing"},
		{"too old by json", fmt.Errorf("old: %w", stkclient.ErrStkTooOld), "stk-too-old"},
		{"not runnable", fmt.Errorf("perm: %w", stkclient.ErrStkNotRunnable), "stk-not-runnable"},
	}
	for _, r := range reasons {
		t.Run(r.name, func(t *testing.T) {
			h := newHarness(t)
			h.svc.Ensure = func(context.Context) (SetupResult, error) { return SetupResult{}, r.err }
			verbs := map[string]func() error{
				"deliver": func() error {
					_, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com"))
					return err
				},
				"verify": func() error {
					_, err := h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_1", GrantID: "fag_aaa111", ExpectLogin: "bot"})
					return err
				},
				"status": func() error { _, err := h.svc.Status(t.Context(), StatusParams{StationID: "stn_1"}); return err },
			}
			for verb, call := range verbs {
				start := time.Now()
				err := call()
				if time.Since(start) > time.Second {
					t.Errorf("%s took %v", verb, time.Since(start))
				}
				if err == nil || !strings.HasPrefix(err.Error(), r.code+":") {
					t.Errorf("%s = %v, want the %s code first", verb, err, r.code)
				}
			}
		})
	}
}

// policy does not call Ensure (it must not install anything): with a grant on file and stk gone,
// the reload failure carries the same reason code in an error ack.
func TestPolicyAnswersTheReasonCodeWhenStkIsGone(t *testing.T) {
	for code, cause := range map[string]error{
		"stk-missing":      stkclient.ErrStkMissing,
		"stk-too-old":      stkclient.ErrStkTooOld,
		"stk-not-runnable": stkclient.ErrStkNotRunnable,
	} {
		h := newHarness(t)
		if ack, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil || !ack.Stored {
			t.Fatalf("deliver = %+v, %v", ack, err)
		}
		h.stub.reloadErr = fmt.Errorf("stk reload: %w", cause)
		start := time.Now()
		ack, err := h.svc.Policy(t.Context(), PolicyParams{StationID: "stn_1", GrantID: "fag_aaa111", Preset: "none", Rules: []Rule{}})
		if time.Since(start) > time.Second {
			t.Errorf("%s: policy was slow", code)
		}
		if err != nil || ack.OK || !strings.HasPrefix(ack.Error, code+":") {
			t.Errorf("%s: policy = %+v, %v; want an error ack with the code first", code, ack, err)
		}
	}
}

// Ensure itself maps a version below the floor to stk-too-old (the --json-less case is already
// ErrStkTooOld from the client; this is the numeric one).
func TestEnsureRefusesAVersionBelowTheFloor(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep(LevelSeparateUser)}, version: "0.0.0"}
	_, err := ensure(t.Context(), f, SetupOptions{}, sysEnv{goos: "linux", euid: 1000})
	if !errors.Is(err, stkclient.ErrStkTooOld) {
		t.Fatalf("err = %v, want ErrStkTooOld", err)
	}
	if f.doctorCalls != 0 {
		t.Error("doctor ran against a stk that is too old")
	}
	h := newHarness(t)
	h.svc.Ensure = func(ctx context.Context) (SetupResult, error) {
		return ensure(ctx, f, SetupOptions{}, sysEnv{goos: "linux", euid: 1000})
	}
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err == nil || !strings.HasPrefix(err.Error(), "stk-too-old:") {
		t.Errorf("Deliver = %v, want stk-too-old first", err)
	}
}

// ---- Task 3b: the shared base policy rides every policy write ----

func (h *harness) writeShared(body string) string {
	h.t.Helper()
	p := filepath.Join(h.t.TempDir(), "stk-shared.yaml")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		h.t.Fatal(err)
	}
	h.svc.SharedPolicyPath = p
	return p
}

func TestDeliverCopiesSharedEntriesIntoThePolicyBeforeReload(t *testing.T) {
	h := newHarness(t)
	h.writeShared(sharedBase)
	var seenAtReload []byte
	h.stub.onReload = func(policy []byte) error { seenAtReload = policy; return nil }
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"slack:", "shared-forge:", "shared:slack", "forge-forgejo-aaa111"} {
		if !strings.Contains(string(seenAtReload), want) {
			t.Errorf("policy at reload lacks %q:\n%s", want, seenAtReload)
		}
	}
}

func TestPolicyUpdateRefreshesSharedEntriesAndKeepsGrantEntries(t *testing.T) {
	h := newHarness(t)
	sp := h.writeShared(sharedBase)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sp, []byte(strings.Replace(sharedBase, "hooks.example.com", "hooks9.example.com", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	ack, err := h.svc.Policy(t.Context(), PolicyParams{StationID: "stn_1", GrantID: "fag_aaa111", Preset: "issues", Rules: []Rule{}})
	if err != nil || !ack.OK {
		t.Fatalf("%+v %v", ack, err)
	}
	pol := h.policy()
	if !strings.Contains(string(pol), "hooks9.example.com") || strings.Contains(string(pol), "hooks.example.com") {
		t.Errorf("shared entry not refreshed:\n%s", pol)
	}
	if got := serviceNode(t, pol, "forge-forgejo-aaa111")["preset"]; got != "issues" {
		t.Errorf("grant entry = %v", got)
	}
}

func TestDeliverWithAnUnreadableSharedFileChangesNothing(t *testing.T) {
	h := newHarness(t)
	h.writeShared("services: [x]")
	ack, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com"))
	if err == nil || ack.OK || !strings.HasPrefix(err.Error(), "shared-policy-invalid:") {
		t.Fatalf("%+v %v", ack, err)
	}
	if h.policy() != nil || len(h.stub.callList()) != 0 {
		t.Errorf("file or stk touched: %q %v", h.policy(), h.stub.callList())
	}
}

func TestRevokeStillWorksWithAnUnreadableSharedFile(t *testing.T) {
	h := newHarness(t)
	h.writeShared(sharedBase)
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	h.writeShared("services: [x]")
	ack, err := h.svc.Revoke(t.Context(), RevokeParams{StationID: "stn_1", GrantID: "fag_aaa111"})
	if err != nil || !ack.Removed {
		t.Fatalf("%+v %v", ack, err)
	}
	if m, _ := ManagedEntries(h.policy()); len(m) != 0 {
		t.Errorf("grant left: %v", m)
	}
}

func TestMissingSharedFileIsNoSharedEntries(t *testing.T) {
	h := newHarness(t)
	h.svc.SharedPolicyPath = filepath.Join(t.TempDir(), "absent.yaml")
	if _, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "forge.example.com")); err != nil {
		t.Fatal(err)
	}
	if len(SharedServices(h.policy())) != 0 {
		t.Errorf("shared entries from nowhere:\n%s", h.policy())
	}
}

func TestSharedHostBlocksAGrantOnTheSameHostWithAClearCode(t *testing.T) {
	h := newHarness(t)
	h.writeShared(sharedBase)
	// pkg.example.com is brokered by a shared entry; a grant for it conflicts rather than
	// silently shadowing the shared service.
	_, err := h.svc.Deliver(t.Context(), deliverParams("fag_aaa111", "pkg.example.com"))
	if err == nil || !strings.HasPrefix(err.Error(), "policy-conflict:") {
		t.Fatalf("err = %v", err)
	}
}

func TestAServiceBoundToOneStationRefusesFramesForAnother(t *testing.T) {
	h := newHarness(t)
	h.svc.Station = "stn_1"
	other := deliverParams("fag_bbb222", "b.example.com")
	other.StationID = "stn_2"
	if _, err := h.svc.Deliver(t.Context(), other); err == nil || !strings.HasPrefix(err.Error(), "station-mismatch:") {
		t.Fatalf("deliver: %v", err)
	}
	if _, err := h.svc.Status(t.Context(), StatusParams{StationID: "stn_2"}); err == nil || !strings.HasPrefix(err.Error(), "station-mismatch:") {
		t.Fatalf("status: %v", err)
	}
	if ack, _ := h.svc.Policy(t.Context(), PolicyParams{StationID: "stn_2", GrantID: "g", Preset: "read"}); ack.OK || !strings.HasPrefix(ack.Error, "station-mismatch:") {
		t.Fatalf("policy: %+v", ack)
	}
	if _, err := h.svc.Revoke(t.Context(), RevokeParams{StationID: "stn_2", GrantID: "g"}); err == nil {
		t.Fatal("revoke")
	}
	if _, err := h.svc.Verify(t.Context(), VerifyParams{StationID: "stn_2", GrantID: "g", ExpectLogin: "x"}); err == nil {
		t.Fatal("verify")
	}
	if len(h.stub.callList()) != 0 || h.policy() != nil {
		t.Fatal("work done for the wrong station")
	}
}
