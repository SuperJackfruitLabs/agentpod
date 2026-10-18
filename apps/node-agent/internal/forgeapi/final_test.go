package forgeapi

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---- I1: a deliver whose wiring fails must not leave the credential brokered ----

func failingReload(c *InstancesConfig) {
	c.Harness.DaemonReload = func(context.Context) error { return errors.New("systemd refused") }
}

func TestAWiringFailureAfterTheStoreRollsTheGrantBackCredentialFirst(t *testing.T) {
	fx, _ := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) { failingReload(c) })
	// Prepare the instance so the stub exists, then watch the revoke.
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	var entryAtRevoke []bool
	fx.stub("stn_1").brokerStub.onRevoke = func() error {
		entryAtRevoke = append(entryAtRevoke, strings.Contains(string(fx.policyOf("stn_1")), "fag_1"))
		return nil
	}
	_, err := fx.deliverKeyed("stn_1", "fag_1", "forge.example.com")
	if err == nil || !strings.Contains(err.Error(), "harness-wiring-failed") {
		t.Fatalf("err = %v", err)
	}
	if len(entryAtRevoke) != 1 || !entryAtRevoke[0] {
		t.Fatalf("the credential must be forgotten while its policy entry still exists: %v", entryAtRevoke)
	}
	if m, _ := ManagedEntries(fx.policyOf("stn_1")); len(m) != 0 {
		t.Fatalf("the grant is still in the policy: %v", m)
	}
	calls := fx.stub("stn_1").callList()
	last := calls[len(calls)-1]
	if last != "reload" {
		t.Errorf("the removal must be reloaded into stk; calls = %v", calls)
	}
}

func TestARolledBackDeliverReportsAFailedRollback(t *testing.T) {
	fx, _ := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) { failingReload(c) })
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
		t.Fatal(err)
	}
	fx.stub("stn_1").brokerStub.onRevoke = func() error { return errors.New("stk down") }
	_, err := fx.deliverKeyed("stn_1", "fag_1", "forge.example.com")
	if err == nil || !strings.Contains(err.Error(), "ROLLBACK FAILED") {
		t.Fatalf("err = %v; a grant stk may still broker must be said out loud", err)
	}
}

func TestWiringPrechecksRunBeforeAnythingIsStored(t *testing.T) {
	cases := map[string]struct {
		mod  func(*fixture, *InstancesConfig)
		prep func(*fixture)
		want string
	}{
		"a unit another station's file already serves": {
			prep: func(fx *fixture) {
				dir := filepath.Join(fx.root, "harness-env", "stk-other-abcdef")
				_ = os.MkdirAll(dir, 0o700)
				_ = os.WriteFile(filepath.Join(dir, unitOf("hermes:stn_1")+".env"), []byte("x"), 0o600)
			},
			want: "harness-unit-in-use",
		},
		"an agent uid that is the node's own": {
			mod:  func(_ *fixture, c *InstancesConfig) { c.AgentUIDs = func(string) []int { return []int{0} } },
			want: "harness-uid-is-node",
		},
	}
	for name, c := range cases {
		mods := []func(*fixture, *InstancesConfig){}
		if c.mod != nil {
			mods = append(mods, c.mod)
		}
		fx, _ := newWiringFixture(t, mods...)
		if c.prep != nil {
			c.prep(fx)
		}
		_, err := fx.deliverKeyed("stn_1", "fag_1", "forge.example.com")
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v", name, err)
			continue
		}
		if len(fx.plans) != 0 || len(fx.lc.list()) != 0 {
			t.Errorf("%s: an instance was created: %v %v", name, fx.plans, fx.lc.list())
		}
		if inst, ok := fx.m.Instance("stn_1"); ok {
			if s := fx.stubs[inst.Name]; s != nil && len(s.callList()) != 0 {
				t.Errorf("%s: stk was called: %v", name, s.callList())
			}
		}
	}
}

func TestAHealthyDeliverStillSucceedsAndKeepsItsGrant(t *testing.T) {
	fx, _ := newWiringFixture(t)
	if _, err := fx.deliverKeyed("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	if m, _ := ManagedEntries(fx.policyOf("stn_1")); len(m) != 1 {
		t.Fatalf("entries = %v", m)
	}
	_ = bytes.Equal
}

// ---- I4: only stations this node hosts get an instance ----

func hosting(keys ...string) func(*fixture, *InstancesConfig) {
	set := map[string]bool{}
	for _, k := range keys {
		set[k] = true
	}
	return func(_ *fixture, c *InstancesConfig) { c.Hosted = func(key string) bool { return set[key] } }
}

func TestAnUnhostedStationKeyIsRefusedAndCreatesNothing(t *testing.T) {
	fx := newFixture(t, hosting("hermes:other"))
	_, err := fx.deliverKeyed("stn_1", "fag_1", "forge.example.com")
	if err == nil || !strings.HasPrefix(err.Error(), "station-not-hosted:") {
		t.Fatalf("err = %v", err)
	}
	if _, serr := os.Stat(fx.cfg.RegistryPath); serr == nil || len(fx.plans) != 0 || len(fx.lc.list()) != 0 {
		t.Errorf("something was created: %v %v", fx.plans, fx.lc.list())
	}
	// no key at all cannot be bound to a hosted station either
	p := deliverParams("fag_1", "forge.example.com")
	p.StationKey = "  "
	if _, err := fx.m.Deliver(context.Background(), p); err == nil {
		t.Error("a blank station key was accepted")
	}
}

func TestAHostedStationKeyIsServed(t *testing.T) {
	fx := newFixture(t, hosting("hermes:stn_1"))
	if _, err := fx.deliverKeyed("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
}

func TestStatusRefusesAStationWhoseRecordedKeyIsNoLongerHosted(t *testing.T) {
	hosted := true
	fx, _ := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) { c.Hosted = func(string) bool { return hosted } })
	if _, err := fx.deliverKeyed("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	hosted = false
	before := len(fx.stub("stn_1").callList())
	if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err == nil || !strings.HasPrefix(err.Error(), "station-not-hosted:") {
		t.Fatalf("status err = %v", err)
	}
	if _, err := fx.deliverKeyed("stn_1", "fag_2", "other.example.com"); err == nil || !strings.HasPrefix(err.Error(), "station-not-hosted:") {
		t.Fatalf("deliver err = %v", err)
	}
	if got := len(fx.stub("stn_1").callList()); got != before {
		t.Errorf("stk was called for an unhosted station")
	}
}

func TestAStationCannotTakeOverADifferentKey(t *testing.T) {
	fx, _ := newWiringFixture(t, func(_ *fixture, c *InstancesConfig) { c.Hosted = func(string) bool { return true } })
	if _, err := fx.deliverKeyed("stn_1", "fag_1", "forge.example.com"); err != nil {
		t.Fatal(err)
	}
	p := deliverParams("fag_2", "other.example.com")
	p.StationID, p.StationKey = "stn_1", "hermes:somebody-else"
	p.Sealed = Sealed(HandoverPrefix + "SEALED-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if _, err := fx.m.Deliver(context.Background(), p); err == nil || !strings.HasPrefix(err.Error(), "station-key-changed:") {
		t.Fatalf("err = %v", err)
	}
}

func TestPruneStationRemovesOnlyThatRegisteredStation(t *testing.T) {
	fx := newFixture(t)
	for _, st := range []string{"stn_1", "stn_2"} {
		if _, err := fx.deliver(st, "fag_"+st, "forge.example.com"); err != nil {
			t.Fatal(err)
		}
	}
	i1, _ := fx.m.Instance("stn_1")
	// dry run: reports, touches nothing
	n := len(fx.lc.list())
	inst, ok, err := fx.m.PruneStation(context.Background(), "stn_1", true)
	if err != nil || !ok || inst.Name != i1.Name || len(fx.lc.list()) != n {
		t.Fatalf("dry run: %+v %v %v calls %v", inst, ok, err, fx.lc.list()[n:])
	}
	if _, ok := fx.m.Instance("stn_1"); !ok {
		t.Fatal("dry run removed the record")
	}
	// a station the registry does not list is not found, and nothing is touched
	if _, ok, err := fx.m.PruneStation(context.Background(), "stn_unknown", false); err != nil || ok {
		t.Fatalf("unknown: %v %v", ok, err)
	}
	if len(fx.lc.list()) != n {
		t.Fatal("an unlisted station reached the lifecycle")
	}
	if _, ok, err := fx.m.PruneStation(context.Background(), "stn_1", false); err != nil || !ok {
		t.Fatalf("prune: %v %v", ok, err)
	}
	if _, ok := fx.m.Instance("stn_1"); ok {
		t.Error("still registered")
	}
	if _, ok := fx.m.Instance("stn_2"); !ok {
		t.Error("the other station was removed")
	}
}

// ---- I5: a bad setting disables forge.api, not the node ----

func TestUnavailableAnswersEveryVerbWithStkUnavailableAndNoPanic(t *testing.T) {
	u := Unavailable{Cause: errors.New("AGENTPOD_STK_PORTS=\"x\": want MIN-MAX")}
	ctx := context.Background()
	if _, err := u.Deliver(ctx, DeliverParams{}); err == nil || !strings.HasPrefix(err.Error(), "stk-unavailable:") || !strings.Contains(err.Error(), "MIN-MAX") {
		t.Errorf("deliver: %v", err)
	}
	if ack, err := u.Policy(ctx, PolicyParams{}); err != nil || ack.OK || !strings.HasPrefix(ack.Error, "stk-unavailable:") {
		t.Errorf("policy: %+v %v", ack, err)
	}
	if _, err := u.Verify(ctx, VerifyParams{}); err == nil || !strings.HasPrefix(err.Error(), "stk-unavailable:") {
		t.Errorf("verify: %v", err)
	}
	if _, err := u.Revoke(ctx, RevokeParams{}); err == nil || !strings.HasPrefix(err.Error(), "stk-unavailable:") {
		t.Errorf("revoke: %v", err)
	}
	if _, err := u.Status(ctx, StatusParams{}); err == nil || !strings.HasPrefix(err.Error(), "stk-unavailable:") {
		t.Errorf("status: %v", err)
	}
	// a nil manager (forge.api disabled) is safe for the spawn-path hooks
	var m *StationInstances
	if env, hosts := m.EnvForKey("hermes:x"); env != nil || hosts != nil {
		t.Error("nil manager produced an environment")
	}
	m.NoteBlocked("hermes:x", []string{"HTTPS_PROXY"})
	m.RefreshShared(ctx)
}

// ---- I7: a failing station must not make every frame redo every refresh ----

func TestAFailingStationIsBackedOffAndHealthyOnesAreNotRefreshedAgain(t *testing.T) {
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	attempts := map[string]int{}
	fx := newFixture(t, func(_ *fixture, c *InstancesConfig) {
		c.now = func() time.Time { return now }
		c.onRefresh = func(st string) { attempts[st]++ }
	})
	_ = os.MkdirAll(filepath.Dir(fx.cfg.SharedPolicyPath), 0o700)
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, []byte(sharedBase), 0o644)
	for _, st := range []string{"stn_1", "stn_2", "stn_3"} {
		if _, err := fx.m.Status(context.Background(), StatusParams{StationID: st}); err != nil {
			t.Fatal(err)
		}
	}
	// the operator removes both shared services; stn_2's stk cannot forget the credentials
	_ = os.WriteFile(fx.cfg.SharedPolicyPath, nil, 0o644)
	fx.stub("stn_2").brokerStub.onRevoke = func() error { return errors.New("stk down") }
	count := func(st string) int {
		n := 0
		for _, c := range fx.stub(st).callList() {
			if strings.HasPrefix(c, "revoke:") {
				n++
			}
		}
		return n
	}
	frame := func() {
		if _, err := fx.m.Status(context.Background(), StatusParams{StationID: "stn_1"}); err != nil {
			t.Fatal(err)
		}
	}
	for k := range attempts {
		delete(attempts, k)
	}
	frame()
	r1, r2, r3 := count("stn_1"), count("stn_2"), count("stn_3")
	if r1 == 0 || r2 == 0 || r3 == 0 {
		t.Fatalf("first frame: revokes %d %d %d, every station should have been tried", r1, r2, r3)
	}
	for i := 0; i < 5; i++ {
		frame()
	}
	for _, st := range []string{"stn_1", "stn_2", "stn_3"} {
		if attempts[st] != 1 {
			t.Errorf("%s: %d refresh attempts over 6 frames, want exactly 1 (current or backed off)", st, attempts[st])
		}
	}
	if count("stn_1") != r1 || count("stn_3") != r3 {
		t.Errorf("healthy stations were refreshed again: %d %d", count("stn_1"), count("stn_3"))
	}
	if count("stn_2") != r2 {
		t.Errorf("the failing station was retried inside its back-off: %d -> %d", r2, count("stn_2"))
	}
	now = now.Add(90 * time.Second)
	fx.stub("stn_2").brokerStub.onRevoke = nil
	frame()
	if count("stn_2") <= r2 {
		t.Error("the failing station was never retried")
	}
	if serviceNode(t, fx.policyOf("stn_2"), "slack") != nil {
		t.Error("the retry did not clear the stale copy")
	}
}

// svc.mu must never be held across the stk install: a refresh, a status or a revoke for the
// station would otherwise stall behind it.
func TestADeliverWaitingOnTheStkInstallDoesNotHoldTheServiceLock(t *testing.T) {
	h := newHarness(t)
	release := make(chan struct{})
	entered := make(chan struct{})
	h.svc.Ensure = func(ctx context.Context) (SetupResult, error) {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return SetupResult{Report: rep(LevelSeparateUser)}, nil
	}
	h.svc.SharedPolicyPath = h.writeShared(sharedBase)
	done := make(chan error, 1)
	go func() {
		_, err := h.svc.Deliver(context.Background(), deliverParams("fag_1", "forge.example.com"))
		done <- err
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- h.svc.RefreshShared(ctx) }()
	select {
	case err := <-finished:
		if err != nil {
			t.Errorf("refresh: %v", err)
		}
	case <-time.After(time.Second):
		t.Error("RefreshShared blocked behind a deliver that is waiting for the stk install")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestTheStkInstallOutlivesTheFrameThatStartedIt(t *testing.T) {
	var calls int
	release := make(chan struct{})
	var finishedOK bool
	run := func(ctx context.Context) (SetupResult, error) {
		calls++
		select {
		case <-release:
			finishedOK = true
			return SetupResult{Report: rep(LevelSeparateUser)}, nil
		case <-ctx.Done():
			return SetupResult{}, ctx.Err()
		}
	}
	e := &Ensurer{run: run}
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan error, 1)
	go func() { _, err := e.Ensure(ctx); got <- err }()
	time.Sleep(20 * time.Millisecond)
	cancel() // the hub disconnected
	if err := <-got; err == nil {
		t.Fatal("the cancelled caller should return its context error")
	}
	close(release)
	// a later caller joins or reuses the install that kept running
	res, err := e.Ensure(context.Background())
	if err != nil || !finishedOK || res.Report.Isolation.Level != LevelSeparateUser || calls != 1 {
		t.Fatalf("res=%+v err=%v finished=%v calls=%d", res, err, finishedOK, calls)
	}
}

// ---- M3: a cached "protected" verdict does not outlive what it was true of ----

func TestACachedVerdictIsDroppedWhenTheUIDsItWasBasedOnChange(t *testing.T) {
	calls := 0
	fp := "uids=1001"
	e := &Ensurer{
		run: func(context.Context) (SetupResult, error) {
			calls++
			return SetupResult{Report: rep(LevelSeparateUser)}, nil
		},
		fingerprint: func() string { return fp },
	}
	for i := 0; i < 3; i++ {
		if _, err := e.Ensure(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want the verdict cached", calls)
	}
	fp = "uids=2002"
	if _, err := e.Ensure(context.Background()); err != nil || calls != 2 {
		t.Fatalf("a changed mapping must rerun setup: calls=%d err=%v", calls, err)
	}
}

func TestACachedVerdictIsRecheckedAtMostEveryMinute(t *testing.T) {
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	runs, checks := 0, 0
	ok := true
	e := &Ensurer{
		now: func() time.Time { return now },
		run: func(context.Context) (SetupResult, error) {
			runs++
			return SetupResult{Report: rep(LevelSeparateUser)}, nil
		},
		recheck: func(context.Context) bool { checks++; return ok },
	}
	_, _ = e.Ensure(context.Background())
	now = now.Add(30 * time.Second)
	_, _ = e.Ensure(context.Background())
	if checks != 0 || runs != 1 {
		t.Fatalf("rechecked inside a minute: checks=%d runs=%d", checks, runs)
	}
	now = now.Add(31 * time.Second)
	_, _ = e.Ensure(context.Background())
	if checks != 1 || runs != 1 {
		t.Fatalf("after a minute: checks=%d runs=%d", checks, runs)
	}
	// not rechecked again straight away
	_, _ = e.Ensure(context.Background())
	if checks != 1 {
		t.Fatalf("checks = %d", checks)
	}
	// doctor later says the broker is no longer separate-user: setup runs again
	ok = false
	now = now.Add(61 * time.Second)
	_, _ = e.Ensure(context.Background())
	if checks != 2 || runs != 2 {
		t.Fatalf("after doctor stopped saying separate-user: checks=%d runs=%d", checks, runs)
	}
}

// ---- M7: the policy file is never a symlink the node would write through ----

func TestWritePolicyFileRefusesASymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "elsewhere")
	if err := os.WriteFile(target, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "supertoolkit.yaml")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("no symlinks here")
	}
	if err := writePolicyFile(link, []byte("services: {}\n")); err == nil {
		t.Fatal("wrote through a symlink")
	}
	if b, _ := os.ReadFile(target); string(b) != "keep" {
		t.Errorf("the target was changed: %q", b)
	}
	if fi, _ := os.Lstat(link); fi == nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Error("the symlink was replaced")
	}
}
