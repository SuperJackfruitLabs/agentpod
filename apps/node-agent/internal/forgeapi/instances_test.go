package forgeapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// ---- fixtures: a fake host (no root, no systemd, no stk) ----

type fakeLifecycle struct {
	mu        sync.Mutex
	calls     []string
	failOn    map[string]error // "RemoveUser:stk-x" -> error
	onEnable  func(unit string)
	userExist func(string) bool
}

func (f *fakeLifecycle) do(kind, arg string) error {
	f.mu.Lock()
	f.calls = append(f.calls, kind+":"+arg)
	err := f.failOn[kind+":"+arg]
	f.mu.Unlock()
	return err
}
func (f *fakeLifecycle) EnableNow(_ context.Context, u string) error {
	if f.onEnable != nil {
		f.onEnable(u)
	}
	return f.do("EnableNow", u)
}
func (f *fakeLifecycle) StopDisable(_ context.Context, u string) error { return f.do("StopDisable", u) }
func (f *fakeLifecycle) RemoveUnit(_ context.Context, u string) error  { return f.do("RemoveUnit", u) }
func (f *fakeLifecycle) RemoveUser(_ context.Context, u string) error  { return f.do("RemoveUser", u) }
func (f *fakeLifecycle) RemoveTree(_ context.Context, p string) error  { return f.do("RemoveTree", p) }
func (f *fakeLifecycle) list() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// instStk is one instance's stk: a brokerStub plus what setup needs.
type instStk struct {
	*brokerStub
	fx   *fixture
	inst Instance
}

func (s *instStk) HandoverKey(context.Context) (string, error) {
	s.rec("key")
	return "stk-handover-v1:KEY-" + s.inst.Name, nil
}
func (s *instStk) Doctor(context.Context) (stkclient.DoctorReport, error) {
	s.fx.mu.Lock()
	defer s.fx.mu.Unlock()
	if s.fx.installed[s.inst.Name] || s.fx.unboundSaysSeparate {
		return rep(LevelSeparateUser), nil
	}
	return rep("same-user"), nil
}
func (s *instStk) Install(_ context.Context, p stkclient.InstallPlan) (stkclient.InstallReport, error) {
	s.fx.mu.Lock()
	defer s.fx.mu.Unlock()
	s.fx.plans = append(s.fx.plans, p)
	s.fx.installed[s.inst.Name] = true
	// what `stk install` does with the config directory
	if err := os.MkdirAll(filepath.Dir(p.ConfigPath), 0o750); err != nil {
		return stkclient.InstallReport{}, err
	}
	return stkclient.InstallReport{}, s.fx.installErr
}

type fixture struct {
	t    *testing.T
	m    *StationInstances
	lc   *fakeLifecycle
	root string
	cfg  InstancesConfig

	mu         sync.Mutex
	installed  map[string]bool
	plans      []stkclient.InstallPlan
	stubs      map[string]*instStk
	installErr error
	logs       []string
	// unboundSaysSeparate: a client not yet bound to the instance (its user does not exist)
	// describes some OTHER store, which may well be separate-user.
	unboundSaysSeparate bool
}

func newFixture(t *testing.T, mod ...func(*fixture, *InstancesConfig)) *fixture {
	t.Helper()
	root := t.TempDir()
	fx := &fixture{t: t, root: root, installed: map[string]bool{}, stubs: map[string]*instStk{}, lc: &fakeLifecycle{failOn: map[string]error{}}}
	oldLog := logf
	logf = func(f string, a ...any) {
		fx.mu.Lock()
		fx.logs = append(fx.logs, fmt.Sprintf(f, a...))
		fx.mu.Unlock()
	}
	t.Cleanup(func() { logf = oldLog })
	fx.cfg = InstancesConfig{
		RegistryPath:     filepath.Join(root, "agentpod", "stk-instances.json"),
		SharedPolicyPath: filepath.Join(root, "agentpod", "stk-shared.yaml"),
		StateRoot:        filepath.Join(root, "var"), ConfigRoot: filepath.Join(root, "etc"), RuntimeRoot: filepath.Join(root, "run"),
		Lifecycle:  fx.lc,
		AgentUIDs:  uidFor,
		userExists: func(n string) bool { fx.mu.Lock(); defer fx.mu.Unlock(); return fx.installed[n] },
		portFree:   func(int) bool { return true },
		env:        &sysEnv{goos: "linux", euid: 0},
	}
	fx.cfg.NewClient = func(inst Instance) stkclient.Client {
		fx.mu.Lock()
		defer fx.mu.Unlock()
		if s := fx.stubs[inst.Name]; s != nil {
			return s
		}
		s := &instStk{brokerStub: &brokerStub{policyPath: inst.ConfigPath}, fx: fx, inst: inst}
		fx.stubs[inst.Name] = s
		return s
	}
	for _, f := range mod {
		f(fx, &fx.cfg)
	}
	fx.build()
	return fx
}

func (fx *fixture) build() {
	m, err := NewStationInstances(fx.cfg)
	if err != nil {
		fx.t.Fatal(err)
	}
	fx.m = m
}

func (fx *fixture) stub(station string) *instStk {
	fx.t.Helper()
	inst, ok := fx.m.Instance(station)
	if !ok {
		fx.t.Fatalf("no instance for %s", station)
	}
	fx.mu.Lock()
	defer fx.mu.Unlock()
	s := fx.stubs[inst.Name]
	if s == nil {
		fx.t.Fatalf("no stk client was built for %s", station)
	}
	return s
}

func (fx *fixture) policyOf(station string) []byte {
	fx.t.Helper()
	inst, ok := fx.m.Instance(station)
	if !ok {
		fx.t.Fatalf("no instance for %s", station)
	}
	b, _ := os.ReadFile(inst.ConfigPath)
	return b
}

func (fx *fixture) deliver(station, grant, host string) (DeliverAck, error) {
	p := deliverParams(grant, host)
	p.StationID = station
	p.Sealed = Sealed(HandoverPrefix + "SEALED-" + station + "-" + grant + "-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	return fx.m.Deliver(context.Background(), p)
}

func (fx *fixture) planFor(name string) stkclient.InstallPlan {
	fx.t.Helper()
	fx.mu.Lock()
	defer fx.mu.Unlock()
	for _, p := range fx.plans {
		if p.User == name {
			return p
		}
	}
	fx.t.Fatalf("no install for %s: %+v", name, fx.plans)
	return stkclient.InstallPlan{}
}

// uidFor gives each test station its own agent uid, as an operator following the docs would.
func uidFor(station string) []int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(station))
	return []int{1000 + int(h.Sum32()%1_000_000)}
}

// ---- naming and ports ----

func TestEachStationGetsItsOwnDistinctInstallPlan(t *testing.T) {
	fx := newFixture(t)
	for _, st := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliver(st, "fag_"+st, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	a, _ := fx.m.Instance("stn_1")
	b, _ := fx.m.Instance("stn_2")
	pa, pb := fx.planFor(a.Name), fx.planFor(b.Name)
	for what, pair := range map[string][2]string{
		"user": {pa.User, pb.User}, "group": {pa.Group, pb.Group}, "unit": {pa.UnitName, pb.UnitName},
		"state": {pa.StateDir, pb.StateDir}, "runtime": {pa.RuntimeDir, pb.RuntimeDir}, "config": {pa.ConfigPath, pb.ConfigPath},
		"port": {fmt.Sprint(pa.ProxyPort), fmt.Sprint(pb.ProxyPort)},
	} {
		if pair[0] == "" || pair[0] == pair[1] {
			t.Errorf("%s is not distinct: %q vs %q", what, pair[0], pair[1])
		}
	}
	if pa.User != pa.UnitName || pa.User != pa.Group || pa.User != a.Name {
		t.Errorf("user/group/unit differ: %+v", pa)
	}
	if !reflectEq(pa.AgentUIDs, uidFor("stn_1")) {
		t.Errorf("agent uids = %v", pa.AgentUIDs)
	}
	if pa.StateDir != filepath.Join(fx.cfg.StateRoot, a.Name) || pa.ConfigPath != filepath.Join(fx.cfg.ConfigRoot, a.Name, "supertoolkit.yaml") || pa.RuntimeDir != filepath.Join(fx.cfg.RuntimeRoot, a.Name) {
		t.Errorf("paths = %+v", pa)
	}
	if pa.ProxyPort != 8900 || pb.ProxyPort != 8901 {
		t.Errorf("ports = %d, %d; want the range's first two", pa.ProxyPort, pb.ProxyPort)
	}
}

func reflectEq(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestInstanceNamesAreDeterministicSafeAndCollisionFree(t *testing.T) {
	ok := regexp.MustCompile(`^stk-[a-z0-9-]{1,12}-[0-9a-f]{6,14}$`)
	seen := map[string]string{}
	for _, st := range []string{"stn_1", "stn-1", "STN 1", "a/b", "a-b", "../../etc/passwd", "ünï", "!!!", strings.Repeat("x", 120), "stn_1 "} {
		n := instanceName(st, 6)
		if !ok.MatchString(n) || len(n) > 32 {
			t.Errorf("%q -> %q is not a safe name", st, n)
		}
		if instanceName(st, 6) != n {
			t.Errorf("%q is not deterministic", st)
		}
		if other, dup := seen[n]; dup {
			t.Errorf("%q and %q share %q", st, other, n)
		}
		seen[n] = st
		if !regexpNameRE(n) {
			t.Errorf("%q fails stk's name rule", n)
		}
	}
	if n := instanceName("x", maxHex); len(n) > 32 {
		t.Errorf("longest name %q is %d chars; useradd stops at 32", n, len(n))
	}
}

func regexpNameRE(n string) bool {
	return regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`).MatchString(n)
}

func TestAHashCollisionLengthensTheNameInsteadOfSharingAnInstance(t *testing.T) {
	fx := newFixture(t)
	// A different station already holds the name stn_9 would get.
	taken := instanceName("stn_9", 6)
	fx.writeRegistry(`{"version":1,"managedBy":"agentpod-node","instances":[{"station":"someone-else","name":"` + taken + `","port":8900}]}`)
	if _, err := fx.deliver("stn_9", "fag_x1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	inst, _ := fx.m.Instance("stn_9")
	if inst.Name == taken || !strings.HasPrefix(inst.Name, "stk-stn-9-") || inst.Port != 8901 {
		t.Fatalf("instance = %+v", inst)
	}
}

func (fx *fixture) writeRegistry(body string) {
	fx.t.Helper()
	if err := os.MkdirAll(filepath.Dir(fx.cfg.RegistryPath), 0o700); err != nil {
		fx.t.Fatal(err)
	}
	if err := os.WriteFile(fx.cfg.RegistryPath, []byte(body), 0o600); err != nil {
		fx.t.Fatal(err)
	}
}

func TestPortsAndNamesSurviveARestart(t *testing.T) {
	fx := newFixture(t)
	for _, st := range []string{"stn_1", "stn_2", "stn_3"} {
		if _, err := fx.deliver(st, "fag_"+st, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	before := map[string]Instance{}
	for _, st := range []string{"stn_1", "stn_2", "stn_3"} {
		before[st], _ = fx.m.Instance(st)
	}
	fi, err := os.Stat(fx.cfg.RegistryPath)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("registry %v mode %v", err, fi)
	}

	fx2 := newFixtureAt(t, fx)
	for _, st := range []string{"stn_3", "stn_1", "stn_2"} { // another order
		got, ok := fx2.m.Instance(st)
		if !ok || got != before[st] {
			t.Errorf("%s: %+v, want %+v", st, got, before[st])
		}
	}
	// A new station after the restart takes the next free port, not a used one.
	if _, err := fx2.deliver("stn_4", "fag_4", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if got, _ := fx2.m.Instance("stn_4"); got.Port != 8903 {
		t.Errorf("stn_4 port = %d", got.Port)
	}
}

// newFixtureAt is a node restart: same disk, new process.
func newFixtureAt(t *testing.T, old *fixture) *fixture {
	t.Helper()
	fx := newFixture(t, func(fx *fixture, c *InstancesConfig) {
		c.RegistryPath, c.SharedPolicyPath = old.cfg.RegistryPath, old.cfg.SharedPolicyPath
		c.StateRoot, c.ConfigRoot, c.RuntimeRoot = old.cfg.StateRoot, old.cfg.ConfigRoot, old.cfg.RuntimeRoot
		for n, v := range old.installed {
			fx.installed[n] = v
		}
	})
	return fx
}

func TestPortRangeExhaustionIsAClearErrorAndReservesNothing(t *testing.T) {
	fx := newFixture(t, func(_ *fixture, c *InstancesConfig) { c.PortMin, c.PortMax = 8900, 8901 })
	for _, st := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliver(st, "fag_"+st, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	_, err := fx.deliver("stn_3", "fag_3", "forge.example.com")
	if err == nil || !strings.HasPrefix(err.Error(), "port-range-exhausted:") || !strings.Contains(err.Error(), "8900") {
		t.Fatalf("err = %v", err)
	}
	if _, ok := fx.m.Instance("stn_3"); ok {
		t.Error("an instance was recorded without a port")
	}
	if b, _ := os.ReadFile(fx.cfg.RegistryPath); strings.Contains(string(b), "stn_3") {
		t.Errorf("registry holds the refused station:\n%s", b)
	}
	// existing stations keep working
	if _, err := fx.deliver("stn_1", "fag_other", "other.example.com"); err != nil {
		t.Fatalf("existing station after exhaustion: %v", err)
	}
}

func TestAPortAnotherProcessHoldsIsSkipped(t *testing.T) {
	fx := newFixture(t, func(_ *fixture, c *InstancesConfig) { c.portFree = func(p int) bool { return p != 8900 } })
	if _, err := fx.deliver("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if got, _ := fx.m.Instance("stn_1"); got.Port != 8901 {
		t.Errorf("port = %d", got.Port)
	}
}

func TestAnInvalidPortRangeIsRefusedAtStartup(t *testing.T) {
	for _, r := range [][2]int{{9000, 8900}, {0, 70000}, {-1, 5}} {
		_, err := NewStationInstances(InstancesConfig{NewClient: func(Instance) stkclient.Client { return nil }, Lifecycle: &fakeLifecycle{}, PortMin: r[0], PortMax: r[1]})
		if err == nil {
			t.Errorf("range %v accepted", r)
		}
	}
}

// ---- isolation ----

func TestTwoStationsDeliverToTheSameForgeHostEachInItsOwnInstance(t *testing.T) {
	fx := newFixture(t)
	a, err := fx.deliver("stn_1", "fag_aaa111", "forge.example.com")
	if err != nil || !a.OK || !a.Stored {
		t.Fatalf("station 1: %+v %v", a, err)
	}
	b, err := fx.deliver("stn_2", "fag_bbb222", "forge.example.com")
	if err != nil || !b.OK || !b.Stored {
		t.Fatalf("station 2 on the same host was refused: %+v %v", b, err)
	}
	ia, _ := fx.m.Instance("stn_1")
	ib, _ := fx.m.Instance("stn_2")
	if ia.ConfigPath == ib.ConfigPath {
		t.Fatal("one policy file")
	}
	pa, pb := string(fx.policyOf("stn_1")), string(fx.policyOf("stn_2"))
	if !strings.Contains(pa, "fag_aaa111") || !strings.Contains(pb, "fag_bbb222") {
		t.Fatalf("each file must hold its own grant:\n%s\n---\n%s", pa, pb)
	}
	// each station's credential went to its own stk only
	sa, sb := fx.stub("stn_1"), fx.stub("stn_2")
	if len(sa.envelopes) != 1 || len(sb.envelopes) != 1 {
		t.Fatalf("envelopes: %v / %v", sa.envelopes, sb.envelopes)
	}
	for _, e := range sa.envelopes {
		if !strings.Contains(e, "stn_1-fag_aaa111") {
			t.Errorf("station 1 got %q", e)
		}
	}
	for _, e := range sb.envelopes {
		if !strings.Contains(e, "stn_2-fag_bbb222") {
			t.Errorf("station 2 got %q", e)
		}
	}
}

func TestOneStationsFileNeverHoldsAnotherStationsEntriesOrCredentials(t *testing.T) {
	fx := newFixture(t)
	for _, st := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliver(st, "fag_"+st, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []struct{ station, other string }{{"stn_1", "stn_2"}, {"stn_2", "stn_1"}} {
		pol := string(fx.policyOf(c.station))
		if strings.Contains(pol, c.other) || strings.Contains(pol, "fag_"+c.other) {
			t.Errorf("%s's policy mentions %s:\n%s", c.station, c.other, pol)
		}
		for _, e := range fx.stub(c.station).envelopes {
			if strings.Contains(e, c.other) {
				t.Errorf("%s's stk received %s's credential", c.station, c.other)
			}
		}
		m, _ := ManagedEntries([]byte(pol))
		if len(m) != 1 || m[0].Station != c.station {
			t.Errorf("%s entries = %v", c.station, m)
		}
	}
}

func TestRevokeAndPolicyForOneStationLeaveTheOtherUntouched(t *testing.T) {
	fx := newFixture(t)
	for _, st := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliver(st, "fag_"+st, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	before := fx.policyOf("stn_2")
	b := fx.stub("stn_2")
	callsBefore := len(b.callList())
	ack, err := fx.m.Policy(context.Background(), PolicyParams{StationID: "stn_1", GrantID: "fag_stn_1", Preset: "issues", Rules: []Rule{}})
	if err != nil || !ack.OK {
		t.Fatalf("policy: %+v %v", ack, err)
	}
	rv, err := fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_stn_1"})
	if err != nil || !rv.Removed {
		t.Fatalf("revoke: %+v %v", rv, err)
	}
	if !bytes.Equal(before, fx.policyOf("stn_2")) || len(b.callList()) != callsBefore {
		t.Fatalf("station 2 was touched: calls %v", b.callList()[callsBefore:])
	}
	// A grant id that belongs to station 2 cannot be revoked through station 1.
	rv, err = fx.m.Revoke(context.Background(), RevokeParams{StationID: "stn_1", GrantID: "fag_stn_2"})
	if err != nil || rv.Removed || !bytes.Equal(before, fx.policyOf("stn_2")) {
		t.Fatalf("cross-station revoke: %+v %v", rv, err)
	}
	if st, _ := ManagedEntries(fx.policyOf("stn_2")); len(st) != 1 {
		t.Fatalf("station 2 entries = %v", st)
	}
}

func TestStatusReturnsTheKeyOfThatStationsOwnStk(t *testing.T) {
	fx := newFixture(t)
	a, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_2"})
	if err != nil {
		t.Fatal(err)
	}
	ia, _ := fx.m.Instance("stn_1")
	ib, _ := fx.m.Instance("stn_2")
	if a.PublicKey != "stk-handover-v1:KEY-"+ia.Name || b.PublicKey != "stk-handover-v1:KEY-"+ib.Name || a.PublicKey == b.PublicKey {
		t.Fatalf("keys: %q / %q", a.PublicKey, b.PublicKey)
	}
	if a.Grants == nil || len(a.Grants) != 0 {
		t.Errorf("grants = %v", a.Grants)
	}
	// Status created and started the instance.
	if got := fx.lc.list(); !contains(got, "EnableNow:"+ia.Name) || !contains(got, "EnableNow:"+ib.Name) {
		t.Errorf("lifecycle calls = %v", got)
	}
	// Later grants appear under the right station only.
	if _, err := fx.deliver("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	a2, _ := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"})
	b2, _ := fx.m.Status(context.Background(), StatusParams{StationID: "stn_2"})
	if len(a2.Grants) != 1 || len(b2.Grants) != 0 {
		t.Errorf("grants: %v / %v", a2.Grants, b2.Grants)
	}
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func TestAnUnprivilegedNodeCannotCreateInstancesAndSaysSoWithoutUsingPorts(t *testing.T) {
	for _, env := range []sysEnv{{goos: "linux", euid: 1000}, {goos: "darwin", euid: 0}} {
		env := env
		fx := newFixture(t, func(_ *fixture, c *InstancesConfig) { c.env = &env })
		_, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"})
		if err == nil || !strings.HasPrefix(err.Error(), "station-instance-unavailable:") {
			t.Fatalf("%+v: status err = %v", env, err)
		}
		_, err = fx.deliver("stn_1", "fag_1", "forge.example.com")
		if err == nil || !strings.HasPrefix(err.Error(), "station-instance-unavailable:") {
			t.Fatalf("%+v: deliver err = %v", env, err)
		}
		if b, _ := os.ReadFile(fx.cfg.RegistryPath); strings.Contains(string(b), "stn_1") {
			t.Errorf("a port was reserved for an instance that cannot exist:\n%s", b)
		}
		if len(fx.plans) != 0 || len(fx.lc.list()) != 0 {
			t.Errorf("host touched: %v %v", fx.plans, fx.lc.list())
		}
	}
}

func TestVerbsForAStationWithoutAnInstanceCreateNothing(t *testing.T) {
	fx := newFixture(t)
	ctx := context.Background()
	if ack, err := fx.m.Policy(ctx, PolicyParams{StationID: "stn_x", GrantID: "g", Preset: "read"}); err != nil || ack.OK || ack.Error != "unknown-grant" {
		t.Errorf("policy: %+v %v", ack, err)
	}
	if _, err := fx.m.Verify(ctx, VerifyParams{StationID: "stn_x", GrantID: "g", ExpectLogin: "u"}); err == nil || !strings.HasPrefix(err.Error(), "unknown-grant:") {
		t.Errorf("verify: %v", err)
	}
	var unwired []string
	fx.cfg.Unwire = func(g string) error { unwired = append(unwired, g); return nil }
	fx.build()
	if ack, err := fx.m.Revoke(ctx, RevokeParams{StationID: "stn_x", GrantID: "g"}); err != nil || ack.Removed {
		t.Errorf("revoke: %+v %v", ack, err)
	}
	if len(unwired) != 1 || unwired[0] != "g" {
		t.Errorf("unwired = %v", unwired)
	}
	if _, err := os.Stat(fx.cfg.RegistryPath); err == nil || len(fx.plans) != 0 || len(fx.lc.list()) != 0 {
		t.Errorf("something was created: %v %v", fx.plans, fx.lc.list())
	}
}

func TestABadFrameOrStationIdCreatesNoInstance(t *testing.T) {
	fx := newFixture(t)
	p := deliverParams("fag_1", "forge.example.com")
	p.Sealed = "not-an-envelope"
	if _, err := fx.m.Deliver(context.Background(), p); err == nil || !strings.HasPrefix(err.Error(), "invalid-params:") {
		t.Fatalf("err = %v", err)
	}
	for _, id := range []string{"", "  ", strings.Repeat("s", 200), "stn\n1"} {
		if _, err := fx.m.Status(context.Background(), StatusParams{StationID: id}); err == nil || !strings.HasPrefix(err.Error(), "invalid-params:") {
			t.Errorf("station %q: %v", id, err)
		}
	}
	if _, err := os.Stat(fx.cfg.RegistryPath); err == nil || len(fx.plans) != 0 {
		t.Error("an instance was created for a bad frame")
	}
}

func TestEnsureFailureLeavesTheRecordSoARetryReusesThePort(t *testing.T) {
	fx := newFixture(t)
	fx.installErr = errors.New("useradd failed")
	if _, err := fx.deliver("stn_1", "fag_1", "forge.example.com"); err == nil {
		t.Fatal("want error")
	}
	first, _ := fx.m.Instance("stn_1")
	fx.mu.Lock()
	fx.installErr = nil
	fx.mu.Unlock()
	if _, err := fx.deliver("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if again, _ := fx.m.Instance("stn_1"); again != first {
		t.Errorf("%+v then %+v", first, again)
	}
}

// ---- no secret anywhere ----

func TestNoSecretReachesTheRegistryOrTheLogs(t *testing.T) {
	fx := newFixture(t)
	p := deliverParams("fag_1", "forge.example.com")
	p.Sealed = Sealed(realSecret)
	if _, err := fx.m.Deliver(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	reg, _ := os.ReadFile(fx.cfg.RegistryPath)
	if strings.Contains(string(reg), secretBody) || strings.Contains(string(reg), "stk-handover") {
		t.Errorf("registry holds the envelope:\n%s", reg)
	}
	pol := fx.policyOf("stn_1")
	if strings.Contains(string(pol), secretBody) {
		t.Errorf("policy holds the envelope")
	}
	fx.mu.Lock()
	defer fx.mu.Unlock()
	if strings.Contains(strings.Join(fx.logs, "\n"), secretBody) {
		t.Errorf("a log line holds the envelope: %v", fx.logs)
	}
}

// ---- the registry is trusted only if it is ours ----

func TestAnUnusableRegistryIsReportedAndNeverOverwritten(t *testing.T) {
	for name, body := range map[string]string{
		"not json":       `{{{`,
		"foreign":        `{"version":1,"managedBy":"someone","instances":[]}`,
		"future":         `{"version":9,"managedBy":"agentpod-node","instances":[]}`,
		"system name":    `{"version":1,"managedBy":"agentpod-node","instances":[{"station":"s","name":"root","port":8900}]}`,
		"default stk":    `{"version":1,"managedBy":"agentpod-node","instances":[{"station":"s","name":"stk","port":8900}]}`,
		"traversal":      `{"version":1,"managedBy":"agentpod-node","instances":[{"station":"s","name":"stk-../../etc-abcdef","port":8900}]}`,
		"duplicate port": `{"version":1,"managedBy":"agentpod-node","instances":[{"station":"a","name":"stk-a-abcdef","port":8900},{"station":"b","name":"stk-b-abcdef","port":8900}]}`,
		"bad port":       `{"version":1,"managedBy":"agentpod-node","instances":[{"station":"a","name":"stk-a-abcdef","port":0}]}`,
	} {
		fx := newFixture(t)
		fx.writeRegistry(body)
		_, err := fx.deliver("stn_1", "fag_1", "forge.example.com")
		if err == nil || !strings.HasPrefix(err.Error(), "registry-") {
			t.Errorf("%s: err = %v", name, err)
		}
		if got, _ := os.ReadFile(fx.cfg.RegistryPath); string(got) != body {
			t.Errorf("%s: registry was rewritten", name)
		}
		if _, perr := fx.m.PruneUnhosted(context.Background(), nil); perr == nil {
			t.Errorf("%s: prune ran on an unusable registry", name)
		}
		if len(fx.lc.list()) != 0 {
			t.Errorf("%s: host touched: %v", name, fx.lc.list())
		}
	}
}

// ---- removal ----

func TestPruneRemovesOnlyRegistryInstancesOfStationsNoLongerHosted(t *testing.T) {
	fx := newFixture(t)
	for _, st := range []string{"stn_1", "stn_2", "stn_3"} {
		if _, err := fx.deliver(st, "fag_"+st, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	i1, _ := fx.m.Instance("stn_1")
	i2, _ := fx.m.Instance("stn_2")
	i3, _ := fx.m.Instance("stn_3")
	// Things on the host that look similar but are not the node's: never named to the Lifecycle.
	fx.lc.mu.Lock()
	fx.lc.calls = nil
	fx.lc.mu.Unlock()

	gone, err := fx.m.PruneUnhosted(context.Background(), []string{"stn_2", "unknown-station"})
	if err != nil || len(gone) != 2 {
		t.Fatalf("gone = %v, %v", gone, err)
	}
	calls := fx.lc.list()
	for _, c := range calls {
		if strings.Contains(c, i2.Name) {
			t.Errorf("the hosted station's instance was touched: %s", c)
		}
		if !strings.Contains(c, i1.Name) && !strings.Contains(c, i3.Name) {
			t.Errorf("a call names something outside the registry: %s", c)
		}
	}
	want := func(name string, inst Instance) []string {
		return []string{
			"StopDisable:" + name, "RemoveUnit:" + name, "RemoveUser:" + name,
			"RemoveTree:" + inst.StateDir, "RemoveTree:" + inst.RuntimeDir, "RemoveTree:" + filepath.Dir(inst.ConfigPath),
		}
	}
	for _, c := range want(i1.Name, i1) {
		if !contains(calls, c) {
			t.Errorf("missing %s in %v", c, calls)
		}
	}
	// order for one instance: stop the unit before the user is deleted, user before its files
	idx := func(s string) int {
		for i, c := range calls {
			if c == s {
				return i
			}
		}
		return -1
	}
	if !(idx("StopDisable:"+i1.Name) < idx("RemoveUnit:"+i1.Name) && idx("RemoveUnit:"+i1.Name) < idx("RemoveUser:"+i1.Name) && idx("RemoveUser:"+i1.Name) < idx("RemoveTree:"+i1.StateDir)) {
		t.Errorf("order = %v", calls)
	}
	if _, ok := fx.m.Instance("stn_1"); ok {
		t.Error("registry still lists stn_1")
	}
	if _, ok := fx.m.Instance("stn_2"); !ok {
		t.Error("hosted station lost")
	}
	b, _ := os.ReadFile(fx.cfg.RegistryPath)
	if strings.Contains(string(b), i1.Name) || strings.Contains(string(b), i3.Name) || !strings.Contains(string(b), i2.Name) {
		t.Errorf("registry:\n%s", b)
	}
	// idempotent
	fx.lc.mu.Lock()
	fx.lc.calls = nil
	fx.lc.mu.Unlock()
	gone, err = fx.m.PruneUnhosted(context.Background(), []string{"stn_2"})
	if err != nil || len(gone) != 0 || len(fx.lc.list()) != 0 {
		t.Errorf("second prune: %v %v %v", gone, err, fx.lc.list())
	}
	// the freed port is reused
	if _, err := fx.deliver("stn_4", "fag_4", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if got, _ := fx.m.Instance("stn_4"); got.Port != i1.Port {
		t.Errorf("stn_4 port = %d, want the freed %d", got.Port, i1.Port)
	}
}

func TestPruneWithAnEmptyRegistryTouchesNothing(t *testing.T) {
	fx := newFixture(t)
	gone, err := fx.m.PruneUnhosted(context.Background(), nil)
	if err != nil || len(gone) != 0 || len(fx.lc.list()) != 0 {
		t.Fatalf("%v %v %v", gone, err, fx.lc.list())
	}
}

func TestAFailedPruneKeepsTheRecordAndTheNextCallFinishesTheJob(t *testing.T) {
	fx := newFixture(t)
	if _, err := fx.deliver("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	i1, _ := fx.m.Instance("stn_1")
	fx.lc.failOn["RemoveUser:"+i1.Name] = errors.New("userdel: user is logged in")
	gone, err := fx.m.PruneUnhosted(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "instance-remove-failed") || len(gone) != 0 {
		t.Fatalf("%v %v", gone, err)
	}
	if _, ok := fx.m.Instance("stn_1"); !ok {
		t.Fatal("record dropped although the user is still there")
	}
	delete(fx.lc.failOn, "RemoveUser:"+i1.Name)
	gone, err = fx.m.PruneUnhosted(context.Background(), nil)
	if err != nil || len(gone) != 1 {
		t.Fatalf("retry: %v %v", gone, err)
	}
	if _, ok := fx.m.Instance("stn_1"); ok {
		t.Error("still registered")
	}
}

func TestPruneUnwiresTheStationsGrantsBeforeRemovingTheInstance(t *testing.T) {
	var order []string
	fx := newFixture(t, func(fx *fixture, c *InstancesConfig) {
		c.Unwire = func(g string) error { order = append(order, "unwire:"+g); return nil }
	})
	if _, err := fx.deliver("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.m.PruneUnhosted(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if len(order) != 1 || order[0] != "unwire:fag_1" {
		t.Fatalf("unwired = %v", order)
	}
}

func mustName(fx *fixture, st string) string { i, _ := fx.m.Instance(st); return i.Name }

// ---- shared base policy ----

func TestSharedEntriesAreSeededBeforeTheUnitStartsAndRefreshedOnWrites(t *testing.T) {
	var atStart []byte
	fx := newFixture(t)
	if err := os.MkdirAll(filepath.Dir(fx.cfg.SharedPolicyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fx.cfg.SharedPolicyPath, []byte(sharedBase), 0o644); err != nil {
		t.Fatal(err)
	}
	fx.lc.onEnable = func(unit string) {
		for _, p := range []string{filepath.Join(fx.cfg.ConfigRoot, unit, "supertoolkit.yaml")} {
			atStart, _ = os.ReadFile(p)
		}
	}
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(atStart), "shared:slack") || !strings.Contains(string(atStart), "stn_1") {
		t.Fatalf("shared entries were not in the policy when the unit started:\n%s", atStart)
	}
	// a second station gets its own copy, labelled with itself
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_2"}); err != nil {
		t.Fatal(err)
	}
	if l := labelsOfService(t, fx.policyOf("stn_2"), "slack"); l["station"] != "stn_2" {
		t.Errorf("stn_2 shared labels = %v", l)
	}
	// operator edits the shared file; the next write for either station refreshes its copy
	changed := strings.Replace(sharedBase, "hooks.example.com", "hooks9.example.com", 1)
	if err := os.WriteFile(fx.cfg.SharedPolicyPath, []byte(changed), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.deliver("stn_1", "fag_aaa111", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(fx.policyOf("stn_1")), "hooks9.example.com") {
		t.Error("stn_1 copy not refreshed")
	}
	if !strings.Contains(string(fx.policyOf("stn_2")), "hooks9") {
		t.Error("stn_2 copy not refreshed by a frame for another station")
	}
	// removing the shared entries never removes the station's own grant
	if err := os.WriteFile(fx.cfg.SharedPolicyPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.m.Policy(context.Background(), PolicyParams{StationID: "stn_1", GrantID: "fag_aaa111", Preset: "issues", Rules: []Rule{}}); err != nil {
		t.Fatal(err)
	}
	pol := fx.policyOf("stn_1")
	if len(SharedServices(pol)) != 0 {
		t.Errorf("shared entries remain:\n%s", pol)
	}
	if m, _ := ManagedEntries(pol); len(m) != 1 {
		t.Errorf("grant entries = %v", m)
	}
}

func TestSharedPolicyProblemsDoNotStopTheInstanceFromBeingCreated(t *testing.T) {
	fx := newFixture(t)
	_ = os.MkdirAll(filepath.Dir(fx.cfg.SharedPolicyPath), 0o700)
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, []byte("services: [x]"), 0o644)
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatalf("status: %v", err)
	}
	if _, err := fx.deliver("stn_1", "fag_1", "forge.example.com"); err == nil || !strings.HasPrefix(err.Error(), "shared-policy-invalid:") {
		t.Fatalf("deliver: %v", err)
	}
}

// ---- concurrency ----

func TestStationsDeliverInParallelButOneStationIsSerialised(t *testing.T) {
	fx := newFixture(t)
	// warm both instances so installs do not muddy the timing
	for _, st := range []string{"stn_1", "stn_2"} {
		if _, err := fx.m.Status(context.Background(), StatusParams{StationID: st}); err != nil {
			t.Fatal(err)
		}
	}
	// Parallel: each station's HandoverOpen waits until the other station is inside its own
	// HandoverOpen too. A lock shared between stations never lets that happen.
	var inside, overlapped int32
	var omu sync.Mutex
	enter := func() {
		omu.Lock()
		inside++
		if inside == 2 {
			overlapped = 1
		}
		omu.Unlock()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			omu.Lock()
			ok := overlapped == 1
			omu.Unlock()
			if ok {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		omu.Lock()
		inside--
		omu.Unlock()
	}
	for _, st := range []string{"stn_1", "stn_2"} {
		fx.stub(st).brokerStub.onOpen = enter
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, st := range []string{"stn_1", "stn_2"} {
		st := st
		wg.Add(1)
		go func() { defer wg.Done(); _, err := fx.deliver(st, "fag_"+st, "forge.example.com"); errs <- err }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	omu.Lock()
	ok := overlapped == 1
	omu.Unlock()
	if !ok {
		t.Fatal("two stations never ran at the same time")
	}

	// Same station: at most one operation in flight.
	s := fx.stub("stn_1")
	var cur, peak int32
	var mu sync.Mutex
	s.brokerStub.onOpen = func() {
		mu.Lock()
		cur++
		if cur > peak {
			peak = cur
		}
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		cur--
		mu.Unlock()
	}
	var wg2 sync.WaitGroup
	for i := 0; i < 6; i++ {
		i := i
		wg2.Add(1)
		go func() {
			defer wg2.Done()
			if _, err := fx.deliver("stn_1", fmt.Sprintf("fag_n%d", i), fmt.Sprintf("h%d.example.com", i)); err != nil {
				t.Error(err)
			}
		}()
	}
	wg2.Wait()
	if peak != 1 {
		t.Fatalf("peak concurrent operations on one station = %d, want 1", peak)
	}
}

func TestConcurrentFirstDeliveriesToOneStationInstallOnce(t *testing.T) {
	fx := newFixture(t)
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := fx.deliver("stn_1", fmt.Sprintf("fag_c%d", i), fmt.Sprintf("h%d.example.com", i)); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(fx.plans) != 1 {
		t.Fatalf("installs = %d, want 1", len(fx.plans))
	}
}

func TestAnExistingInstallIsNotReinstalledAfterARestart(t *testing.T) {
	fx := newFixture(t)
	if _, err := fx.deliver("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	fx2 := newFixtureAt(t, fx)
	if _, err := fx2.deliver("stn_1", "fag_2", "other.example.com"); err != nil {
		t.Fatal(err)
	}
	if len(fx2.plans) != 0 {
		t.Errorf("reinstalled after restart: %+v", fx2.plans)
	}
}

// ---- the real Lifecycle ----

func TestSystemLifecycleRemovesOnlyTreesUnderItsRootsNamedLikeInstances(t *testing.T) {
	root := t.TempDir()
	l := &SystemLifecycle{Roots: []string{root}}
	inst := filepath.Join(root, "stk-st-abcdef")
	other := filepath.Join(root, "stk") // the default instance, not ours to remove
	bystander := filepath.Join(root, "postgres")
	for _, d := range []string{inst, other, bystander} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, bad := range []string{other, bystander, root, "/", "relative/stk-st-abcdef", inst + "/../stk", filepath.Join(inst, "sub"), "/var/lib/stk-st-abcdef"} {
		if err := l.RemoveTree(t.Context(), bad); err == nil {
			t.Errorf("RemoveTree(%q) succeeded", bad)
		}
	}
	for _, d := range []string{other, bystander} {
		if _, err := os.Stat(d); err != nil {
			t.Errorf("%s was removed", d)
		}
	}
	if err := l.RemoveTree(t.Context(), inst); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(inst); err == nil {
		t.Error("instance dir still there")
	}
	if err := l.RemoveTree(t.Context(), inst); err != nil {
		t.Errorf("not idempotent: %v", err)
	}
}

func TestSystemLifecycleRunsSystemctlAndUserdelOnlyForInstanceNames(t *testing.T) {
	dir := t.TempDir()
	var ran []string
	l := &SystemLifecycle{
		UnitDir: dir,
		run: func(_ context.Context, name string, args ...string) error {
			ran = append(ran, name+" "+strings.Join(args, " "))
			return nil
		},
		lookupUser: func(string) error { return nil },
	}
	ctx := context.Background()
	const u = "stk-st-abcdef"
	for _, bad := range []string{"stk", "root", "ssh", "stk-x", "stk-st-abcdef;reboot", "-stk-st-abcdef"} {
		if l.EnableNow(ctx, bad) == nil || l.StopDisable(ctx, bad) == nil || l.RemoveUnit(ctx, bad) == nil || l.RemoveUser(ctx, bad) == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if len(ran) != 0 {
		t.Fatalf("commands ran for bad names: %v", ran)
	}
	// StopDisable with no unit file is a no-op; with one it disables.
	if err := l.StopDisable(ctx, u); err != nil || len(ran) != 0 {
		t.Fatalf("%v %v", err, ran)
	}
	if err := os.WriteFile(filepath.Join(dir, u+".service"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := l.StopDisable(ctx, u); err != nil {
		t.Fatal(err)
	}
	if err := l.RemoveUnit(ctx, u); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, u+".service")); err == nil {
		t.Error("unit file remains")
	}
	if err := l.RemoveUnit(ctx, u); err != nil {
		t.Errorf("not idempotent: %v", err)
	}
	if err := l.RemoveUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	if err := l.EnableNow(ctx, u); err != nil {
		t.Fatal(err)
	}
	want := []string{"systemctl disable --now " + u + ".service", "systemctl daemon-reload", "userdel " + u, "systemctl daemon-reload", "systemctl enable --now " + u + ".service"}
	if strings.Join(ran, "|") != strings.Join(want, "|") {
		t.Errorf("ran = %v\nwant %v", ran, want)
	}
}

func TestAnInstanceIsInstalledEvenWhenAnUnboundClientReportsSeparateUser(t *testing.T) {
	fx := newFixture(t, func(fx *fixture, _ *InstancesConfig) { fx.unboundSaysSeparate = true })
	if _, err := fx.deliver("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if len(fx.plans) != 1 {
		t.Fatalf("installs = %d; the answer of a client bound to no instance must not count", len(fx.plans))
	}
}

// ---- registry shared between processes ----

func TestTwoProcessesAllocatingConcurrentlyGetDistinctPortsAndLoseNoRecord(t *testing.T) {
	a := newFixture(t)
	b := newFixtureAt(t, a) // a second process over the SAME registry file
	var wg sync.WaitGroup
	const per = 8
	for i := 0; i < per; i++ {
		for _, fx := range []*fixture{a, b} {
			fx, st := fx, fmt.Sprintf("stn_%c%d", 'a'+rune(map[*fixture]int{a: 0, b: 1}[fx]), i)
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, _, err := fx.m.Ensure(context.Background(), st); err != nil {
					t.Error(err)
				}
			}()
		}
	}
	wg.Wait()
	recs, err := a.m.readRecords()
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2*per {
		t.Fatalf("%d records, want %d: a record was lost", len(recs), 2*per)
	}
	ports := map[int]string{}
	for st, r := range recs {
		if other, dup := ports[r.Port]; dup {
			t.Errorf("port %d given to both %s and %s", r.Port, st, other)
		}
		ports[r.Port] = st
	}
}

func TestAStaleViewNeverOverwritesARecordAnotherProcessWrote(t *testing.T) {
	daemon := newFixture(t)
	if _, err := daemon.deliver("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	// `apn forge-api setup --station` (another process) registers stn_2 after the daemon started.
	cli := newFixtureAt(t, daemon)
	if _, _, err := cli.m.Ensure(context.Background(), "stn_2"); err != nil {
		t.Fatal(err)
	}
	cliInst, _ := cli.m.Instance("stn_2")
	// The daemon then registers stn_3 and later prunes stn_1: neither may drop or reuse stn_2.
	if _, err := daemon.deliver("stn_3", "fag_3", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if got, ok := daemon.m.Instance("stn_2"); !ok || got != cliInst {
		t.Fatalf("stn_2 lost or changed: %+v %v, want %+v", got, ok, cliInst)
	}
	if p3, _ := daemon.m.Instance("stn_3"); p3.Port == cliInst.Port {
		t.Fatalf("stn_3 reuses stn_2's port %d", p3.Port)
	}
	if _, err := daemon.m.PruneUnhosted(context.Background(), []string{"stn_2", "stn_3"}); err != nil {
		t.Fatal(err)
	}
	if got, ok := daemon.m.Instance("stn_2"); !ok || got != cliInst {
		t.Fatalf("prune dropped the other process's record: %+v %v", got, ok)
	}
	if _, ok := daemon.m.Instance("stn_1"); ok {
		t.Error("stn_1 not pruned")
	}
}

// ---- agent uids ----

func TestASecondStationOnTheSameAgentUIDIsRefusedAndReservesNothing(t *testing.T) {
	fx := newFixture(t, func(_ *fixture, c *InstancesConfig) { c.AgentUIDs = func(string) []int { return []int{1001} } })
	if _, err := fx.deliver("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatalf("the first station is never refused: %v", err)
	}
	regBefore, _ := os.ReadFile(fx.cfg.RegistryPath)
	plansBefore, callsBefore := len(fx.plans), len(fx.lc.list())
	_, err := fx.deliver("stn_2", "fag_2", "forge.example.com")
	if err == nil || !strings.HasPrefix(err.Error(), "station-uid-shared:") || !strings.Contains(err.Error(), "own uid") {
		t.Fatalf("deliver err = %v", err)
	}
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_2"}); err == nil || !strings.HasPrefix(err.Error(), "station-uid-shared:") {
		t.Fatalf("status err = %v", err)
	}
	if _, _, err := fx.m.Ensure(context.Background(), "stn_2"); err == nil {
		t.Fatal("the CLI path must refuse too")
	}
	regAfter, _ := os.ReadFile(fx.cfg.RegistryPath)
	if string(regBefore) != string(regAfter) || len(fx.plans) != plansBefore || len(fx.lc.list()) != callsBefore {
		t.Errorf("an instance or port was reserved for the refused station:\n%s", regAfter)
	}
	if _, ok := fx.m.Instance("stn_2"); ok {
		t.Error("refused station is registered")
	}
	// the first station keeps working
	if _, err := fx.deliver("stn_1", "fag_other", "other.example.com"); err != nil {
		t.Errorf("first station after a refusal: %v", err)
	}
}

func TestAcknowledgedSharedUIDProceedsAndSaysSo(t *testing.T) {
	fx := newFixture(t, func(_ *fixture, c *InstancesConfig) {
		c.AgentUIDs = func(string) []int { return []int{1001} }
		c.AllowSharedAgentUID = true
	})
	first, err := fx.deliver("stn_1", "fag_1", "forge.example.com")
	if err != nil || first.Isolation != "separate-user" || first.IsolationDetail != "" {
		t.Fatalf("a lone station is separate-user: %+v %v", first, err)
	}
	ack, err := fx.deliver("stn_2", "fag_2", "forge.example.com")
	if err != nil || !ack.OK || !ack.Stored {
		t.Fatalf("%+v %v", ack, err)
	}
	// "same-user" is the contract's word for anything short of separate-user; the detail says why.
	if ack.Isolation == "separate-user" || ack.IsolationDetail != IsolationSharedUID || !strings.Contains(ack.Reason, "share an agent uid") {
		t.Fatalf("ack = %+v", ack)
	}
	st, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_2"})
	if err != nil || len(st.Grants) != 1 || st.Grants[0].Isolation == "separate-user" || st.Grants[0].IsolationDetail != IsolationSharedUID || len(st.Warnings) == 0 {
		t.Fatalf("status = %+v %v", st, err)
	}
	// station 1 now shares as well
	v, err := fx.m.Verify(context.Background(), VerifyParams{StationID: "stn_1", GrantID: "fag_1", ExpectLogin: "agent-press"})
	if err != nil || v.IsolationDetail != IsolationSharedUID {
		t.Fatalf("verify = %+v %v", v, err)
	}
	// a loud warning once per instance
	warnings := 0
	fx.mu.Lock()
	for _, l := range fx.logs {
		if strings.Contains(l, "WARNING") && strings.Contains(l, "stn_2") {
			warnings++
		}
	}
	fx.mu.Unlock()
	if warnings != 1 {
		t.Errorf("warnings for stn_2 = %d, want exactly 1", warnings)
	}
}

func TestDistinctAgentUIDsAreSeparateUser(t *testing.T) {
	fx := newFixture(t)
	for _, st := range []string{"stn_1", "stn_2"} {
		ack, err := fx.deliver(st, "fag_"+st, "forge.example.com")
		if err != nil || ack.Isolation != "separate-user" || ack.IsolationDetail != "" || ack.Reason != "" {
			t.Fatalf("%s: %+v %v", st, ack, err)
		}
	}
	rec, _ := fx.m.readRecords()
	if !reflectEq(rec["stn_1"].AgentUIDs, uidFor("stn_1")) || !reflectEq(rec["stn_2"].AgentUIDs, uidFor("stn_2")) {
		t.Errorf("registry uids = %+v", rec)
	}
}

func TestOverlapWithJustOneOfSeveralStationsIsRefused(t *testing.T) {
	uids := map[string][]int{"stn_1": {1}, "stn_2": {2, 3}, "stn_3": {3}}
	fx := newFixture(t, func(_ *fixture, c *InstancesConfig) { c.AgentUIDs = func(s string) []int { return uids[s] } })
	for _, st := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliver(st, "fag_"+st, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fx.deliver("stn_3", "fag_3", "forge.example.com"); err == nil || !strings.HasPrefix(err.Error(), "station-uid-shared:") {
		t.Fatalf("err = %v", err)
	}
}

// ---- a removed shared service ----

func TestARemovedSharedServiceLeavesEveryStationAndItsCredentialIsForgotten(t *testing.T) {
	fx := newFixture(t)
	_ = os.MkdirAll(filepath.Dir(fx.cfg.SharedPolicyPath), 0o700)
	if err := os.WriteFile(fx.cfg.SharedPolicyPath, []byte(sharedBase), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, st := range []string{"stn_1", "stn_2"} {
		if _, err := fx.m.Status(context.Background(), StatusParams{StationID: st}); err != nil {
			t.Fatal(err)
		}
	}
	// the instances are running with a shared "slack" copy; remove it from the shared file
	trimmed := sharedBase[:strings.Index(sharedBase, "  shared-forge:")]
	trimmed = strings.Replace(trimmed, "  slack:", "  keepme:", 1)
	if err := os.WriteFile(fx.cfg.SharedPolicyPath, []byte(trimmed), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, st := range []string{"stn_1", "stn_2"} {
		fx.stub(st).brokerStub.onRevoke = func() error {
			return nil
		}
	}
	// any frame, for any station, triggers the refresh
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	for _, st := range []string{"stn_1", "stn_2"} {
		pol := fx.policyOf(st)
		if serviceNode(t, pol, "slack") != nil || serviceNode(t, pol, "shared-forge") != nil || serviceNode(t, pol, "keepme") == nil {
			t.Errorf("%s policy not refreshed:\n%s", st, pol)
		}
		calls := fx.stub(st).callList()
		if !contains(calls, "revoke:slack") || !contains(calls, "revoke:shared-forge") {
			t.Errorf("%s: stale copies' credentials not forgotten: %v", st, calls)
		}
	}
}

func TestTheCredentialIsForgottenBeforeTheCopyLeavesThePolicy(t *testing.T) {
	fx := newFixture(t)
	_ = os.MkdirAll(filepath.Dir(fx.cfg.SharedPolicyPath), 0o700)
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, []byte(sharedBase), 0o644)
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, nil, 0o644)
	var sawEntry []bool
	fx.stub("stn_1").brokerStub.onRevoke = func() error {
		sawEntry = append(sawEntry, strings.Contains(string(fx.policyOf("stn_1")), "slack:"))
		return nil
	}
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	if len(sawEntry) == 0 {
		t.Fatal("nothing forgotten")
	}
	for _, saw := range sawEntry {
		if !saw {
			t.Error("a credential was forgotten after its policy entry was already gone: stk could not have found it")
		}
	}
}

func TestAFailedForgetKeepsTheCopyAndIsRetried(t *testing.T) {
	fx := newFixture(t)
	_ = os.MkdirAll(filepath.Dir(fx.cfg.SharedPolicyPath), 0o700)
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, []byte(sharedBase), 0o644)
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, nil, 0o644)
	stub := fx.stub("stn_1").brokerStub
	stub.onRevoke = func() error { return errors.New("stk down") }
	_, _ = fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"})
	if serviceNode(t, fx.policyOf("stn_1"), "slack") == nil {
		t.Fatal("the copy left the policy although its credential could not be forgotten")
	}
	stub.onRevoke = nil
	_, _ = fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"})
	if serviceNode(t, fx.policyOf("stn_1"), "slack") != nil {
		t.Fatal("not retried on the next frame")
	}
}

func TestSharedPolicyIsRefreshedAtNodeStart(t *testing.T) {
	fx := newFixture(t)
	_ = os.MkdirAll(filepath.Dir(fx.cfg.SharedPolicyPath), 0o700)
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, []byte(sharedBase), 0o644)
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	// the operator removes the service while the node is down
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, nil, 0o644)
	fx2 := newFixtureAt(t, fx)
	fx2.m.RefreshShared(context.Background())
	if serviceNode(t, fx.policyOf("stn_1"), "slack") != nil {
		t.Fatal("stale copy survived the restart")
	}
	if !contains(fx2.stub("stn_1").callList(), "revoke:slack") {
		t.Fatal("credential not forgotten at start")
	}
}

func TestStatusReportsASharedPolicyThatCouldNotBeSeeded(t *testing.T) {
	fx := newFixture(t)
	_ = os.MkdirAll(filepath.Dir(fx.cfg.SharedPolicyPath), 0o700)
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, []byte("services: [x]"), 0o644)
	st, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"})
	if err != nil || len(st.Warnings) != 1 || !strings.Contains(st.Warnings[0], "shared base policy") {
		t.Fatalf("%+v %v", st, err)
	}
}
