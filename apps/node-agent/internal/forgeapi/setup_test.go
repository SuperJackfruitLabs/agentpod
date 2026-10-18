package forgeapi

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// secretish is what a leaked passphrase or key would look like to the scrubber.
const secretish = "pass_ZXhhbXBsZVBhc3NwaHJhc2VOZXZlclByaW50ZWQ"

// fakeStk is a stkclient.Client whose methods the tests script. Only Version,
// Doctor and Install matter to setup; the rest panic so a stray call is loud.
type fakeStk struct {
	stkclient.Client // nil: any other method panics

	mu          sync.Mutex
	versionErr  error
	version     string                   // default 0.0.3
	doctors     []stkclient.DoctorReport // consumed in order; last one repeats
	doctorErr   error
	installOut  string
	installErr  error
	installs    []stkclient.InstallPlan
	doctorCalls int
	installDone chan struct{} // if set, Install blocks on it
	stateful    bool          // doctors[0] before any install started, doctors[1] after
}

func (f *fakeStk) Version(context.Context) (string, error) {
	if f.version != "" {
		return f.version, f.versionErr
	}
	return "0.0.3", f.versionErr
}

func (f *fakeStk) Doctor(context.Context) (stkclient.DoctorReport, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.doctorCalls++
	if f.doctorErr != nil {
		return stkclient.DoctorReport{}, f.doctorErr
	}
	i := f.doctorCalls - 1
	if f.stateful {
		i = 0
		if len(f.installs) > 0 {
			i = 1
		}
	}
	if i >= len(f.doctors) {
		i = len(f.doctors) - 1
	}
	return f.doctors[i], nil
}

func (f *fakeStk) Install(_ context.Context, p stkclient.InstallPlan) (stkclient.InstallReport, error) {
	f.mu.Lock()
	f.installs = append(f.installs, p)
	ch := f.installDone
	f.mu.Unlock()
	if ch != nil {
		<-ch
	}
	return stkclient.InstallReport{Output: f.installOut}, f.installErr
}

func (f *fakeStk) installCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.installs)
}

func rep(level string, reasons ...string) stkclient.DoctorReport {
	return stkclient.DoctorReport{Isolation: stkclient.Isolation{Level: level, Method: "mode-bits", Reasons: reasons}}
}

func rootLinux(uids ...int) sysEnv {
	return sysEnv{goos: "linux", euid: 0, harnessUIDs: func() []int { return uids }}
}

func TestSetupRunsStkInstallOnceAndIsIdempotent(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user"), rep("separate-user"), rep("separate-user")}}
	opts := SetupOptions{AgentUIDs: []int{1001, 1002}}

	res, err := ensure(context.Background(), f, opts, rootLinux())
	if err != nil {
		t.Fatal(err)
	}
	if f.installCount() != 1 {
		t.Fatalf("installs = %d, want 1", f.installCount())
	}
	p := f.installs[0]
	if p.User != "stk" || p.Group != "stk" || len(p.AgentUIDs) != 2 || p.AgentUIDs[0] != 1001 || p.ProxyPort != 0 {
		t.Fatalf("plan = %+v", p)
	}
	if res.Report.Isolation.Level != "separate-user" || !res.Installed || res.Degraded {
		t.Fatalf("result = %+v", res)
	}

	// Second (lazy, defaulted-uid) call: doctor already says separate-user, install must not run again.
	res, err = ensure(context.Background(), f, SetupOptions{}, rootLinux(1001))
	if err != nil || res.Installed || f.installCount() != 1 {
		t.Fatalf("second call: err=%v installed=%v installs=%d", err, res.Installed, f.installCount())
	}
}

func TestSetupPassesCustomUserAndStateDir(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user"), rep("separate-user")}}
	_, err := ensure(context.Background(), f, SetupOptions{ServiceUser: "stkx", StateDir: "/srv/stk", AgentUIDs: []int{7}}, rootLinux())
	if err != nil {
		t.Fatal(err)
	}
	p := f.installs[0]
	if p.User != "stkx" || p.Group != "stkx" || p.StateDir != "/srv/stk" {
		t.Fatalf("plan = %+v", p)
	}
}

func TestNonRootWithoutInstallReportsSameUserWithReason(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user", "store readable by agent")}}
	env := sysEnv{goos: "linux", euid: 1000, harnessUIDs: func() []int { return []int{1000} }}
	res, err := ensure(context.Background(), f, SetupOptions{}, env)
	if err != nil {
		t.Fatalf("non-root must not fail: %v", err)
	}
	if f.installCount() != 0 {
		t.Fatal("non-root must not run install")
	}
	if !res.Degraded || res.Report.Isolation.Level != "same-user" {
		t.Fatalf("result = %+v", res)
	}
	for _, want := range []string{"not running as root", "sudo agentpod-node forge-api setup", "same-user mode", "no protection against reading the store"} {
		if !strings.Contains(res.Reason, want) {
			t.Errorf("reason %q missing %q", res.Reason, want)
		}
	}
	if got := explain(res.Report, 1000, "linux"); got != res.Reason {
		t.Errorf("Explain = %q, want %q", got, res.Reason)
	}
	if Explain(rep("separate-user"), 0) != "" {
		t.Error("separate-user needs no explanation")
	}
}

func TestNonRootAlreadySeparateUserIsNotDegraded(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("separate-user")}}
	res, err := ensure(context.Background(), f, SetupOptions{}, sysEnv{goos: "linux", euid: 1000})
	if err != nil || res.Degraded || res.Reason != "" || f.installCount() != 0 {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestAgentUIDsDefaultToHarnessUID(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user"), rep("separate-user")}}
	if _, err := ensure(context.Background(), f, SetupOptions{}, rootLinux(4242)); err != nil {
		t.Fatal(err)
	}
	if got := f.installs[0].AgentUIDs; len(got) != 1 || got[0] != 4242 {
		t.Fatalf("agent uids = %v, want [4242]", got)
	}
}

func TestNoDeterminableAgentUIDRefusesBeforeInstall(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user")}}
	_, err := ensure(context.Background(), f, SetupOptions{}, rootLinux())
	if !errors.Is(err, ErrNoAgentUID) {
		t.Fatalf("err = %v, want ErrNoAgentUID", err)
	}
	if f.installCount() != 0 {
		t.Fatal("install ran with an empty allowlist")
	}
	if _, err := ensure(context.Background(), f, SetupOptions{AgentUIDs: []int{-1}}, rootLinux()); err == nil {
		t.Fatal("negative uid must be rejected")
	}
}

func TestSetupNeverLeaksPassphraseOrKey(t *testing.T) {
	var logs bytes.Buffer
	old := logf
	logf = func(format string, a ...any) { log.New(&logs, "", 0).Printf(format, a...) }
	defer func() { logf = old }()

	// Success path with a chatty install.
	f := &fakeStk{installOut: "wrote stk-passphrase.key passphrase=" + secretish, doctors: []stkclient.DoctorReport{rep("same-user"), rep("separate-user")}}
	res, err := ensure(context.Background(), f, SetupOptions{AgentUIDs: []int{1}}, rootLinux())
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	WriteSummary(&out, res)

	// Failure path: the error text itself carries a secret.
	g := &fakeStk{installErr: errors.New("stk install: bad key " + secretish), doctors: []stkclient.DoctorReport{rep("same-user")}}
	_, gerr := ensure(context.Background(), g, SetupOptions{AgentUIDs: []int{1}}, rootLinux())
	if gerr == nil {
		t.Fatal("want install failure")
	}
	// Doctor reasons are stk-provided text too.
	h := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user", "key "+secretish)}}
	hres, _ := ensure(context.Background(), h, SetupOptions{}, sysEnv{goos: "linux", euid: 1})
	var out2 bytes.Buffer
	WriteSummary(&out2, hres)

	for name, s := range map[string]string{"summary": out.String(), "logs": logs.String(), "error": gerr.Error(), "reasons": out2.String() + hres.Reason} {
		if strings.Contains(s, secretish) || strings.Contains(s, "passphrase=") {
			t.Errorf("%s leaks a secret: %q", name, s)
		}
	}
}

func TestUnsupportedPlatformReturnsClearError(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user")}}
	env := sysEnv{goos: "darwin", euid: 0, harnessUIDs: func() []int { return []int{501} }}
	res, err := ensure(context.Background(), f, SetupOptions{}, env)
	if !errors.Is(err, ErrUnsupportedPlatform) || !strings.Contains(err.Error(), "darwin") {
		t.Fatalf("err = %v", err)
	}
	if f.installCount() != 0 {
		t.Fatal("install must not run on an unsupported platform")
	}
	if res.Report.Isolation.Level != "same-user" {
		t.Fatalf("the honest report must still come back: %+v", res)
	}

	// Non-root on that platform: not an error, but labelled and explained.
	res, err = ensure(context.Background(), f, SetupOptions{}, sysEnv{goos: "darwin", euid: 501})
	if err != nil || !res.Degraded || !strings.Contains(res.Reason, "darwin") {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestMissingStkMessageSaysHowToInstall(t *testing.T) {
	f := &fakeStk{versionErr: stkclient.ErrStkMissing}
	_, err := ensure(context.Background(), f, SetupOptions{StkBinary: "/opt/stk"}, rootLinux(1))
	if !errors.Is(err, stkclient.ErrStkMissing) || !strings.Contains(err.Error(), "install stk") || !strings.Contains(err.Error(), "/opt/stk") {
		t.Fatalf("err = %v", err)
	}
	if f.doctorCalls != 0 {
		t.Fatal("doctor must not run before the version probe passes")
	}
}

func TestTooOldStkMessageNamesTheNeededFeature(t *testing.T) {
	f := &fakeStk{versionErr: stkclient.ErrStkTooOld}
	_, err := ensure(context.Background(), f, SetupOptions{}, rootLinux(1))
	if !errors.Is(err, stkclient.ErrStkTooOld) || !strings.Contains(err.Error(), "stk install") || !strings.Contains(err.Error(), "--json") {
		t.Fatalf("err = %v", err)
	}
}

func TestInstallFailureIsSurfacedOnceWithoutRetry(t *testing.T) {
	f := &fakeStk{installErr: errors.New("exit 1"), doctors: []stkclient.DoctorReport{rep("same-user")}}
	_, err := ensure(context.Background(), f, SetupOptions{AgentUIDs: []int{1}}, rootLinux())
	if err == nil || !strings.Contains(err.Error(), "install") {
		t.Fatalf("err = %v", err)
	}
	if f.installCount() != 1 {
		t.Fatalf("installs = %d, want exactly 1", f.installCount())
	}
	if !errors.Is(err, f.installErr) {
		t.Fatal("cause must stay inspectable")
	}
}

func TestRootRechecksDoctorAndErrorsWhenStillNotSeparateUser(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user"), rep("same-user", "service not running")}}
	res, err := ensure(context.Background(), f, SetupOptions{AgentUIDs: []int{1}}, rootLinux())
	if err == nil || !strings.Contains(err.Error(), "systemctl enable --now stk") {
		t.Fatalf("err = %v", err)
	}
	if f.doctorCalls != 2 || f.installCount() != 1 {
		t.Fatalf("doctor=%d installs=%d", f.doctorCalls, f.installCount())
	}
	if res.Report.Isolation.Level != "same-user" || !res.Degraded {
		t.Fatalf("the honest report must come back with the error: %+v", res)
	}
}

func TestEnsurerSingleFlightsConcurrentFirstCalls(t *testing.T) {
	f := &fakeStk{stateful: true, installDone: make(chan struct{}), doctors: []stkclient.DoctorReport{rep("same-user"), rep("separate-user")}}
	e := newEnsurer(f, SetupOptions{AgentUIDs: []int{1}}, rootLinux())

	const n = 8
	var wg sync.WaitGroup
	var bad atomic.Int32
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := e.Ensure(context.Background())
			if err != nil || r.Report.Isolation.Level != "separate-user" {
				bad.Add(1)
			}
		}()
	}
	// Let every caller pile onto the one in-flight install.
	deadline := time.Now().Add(2 * time.Second)
	for f.installCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(f.installDone)
	wg.Wait()
	if bad.Load() != 0 {
		t.Fatalf("%d callers failed", bad.Load())
	}
	if f.installCount() != 1 {
		t.Fatalf("installs = %d, want 1", f.installCount())
	}
	// And a later call is served from the cache without touching stk.
	before := f.doctorCalls
	if _, err := e.Ensure(context.Background()); err != nil || f.doctorCalls != before {
		t.Fatalf("cached call hit stk (err=%v)", err)
	}
}

func TestEnsurerDoesNotCacheFailureOrDegraded(t *testing.T) {
	f := &fakeStk{versionErr: stkclient.ErrStkMissing, doctors: []stkclient.DoctorReport{rep("same-user")}}
	e := newEnsurer(f, SetupOptions{}, sysEnv{goos: "linux", euid: 1000})
	if _, err := e.Ensure(context.Background()); err == nil {
		t.Fatal("want error")
	}
	f.mu.Lock()
	f.versionErr = nil
	f.mu.Unlock()
	r, err := e.Ensure(context.Background())
	if err != nil || r.Report.Isolation.Level != "same-user" {
		t.Fatalf("retry after failure: %v %+v", err, r)
	}
	n := f.doctorCalls
	if _, err := e.Ensure(context.Background()); err != nil || f.doctorCalls == n {
		t.Fatal("a degraded result must be re-checked, not cached (an operator may run setup later)")
	}
}

func TestCLIHarnessUIDsPreferSudoUID(t *testing.T) {
	env := map[string]string{"SUDO_UID": "1001"}
	get := func(k string) string { return env[k] }
	if got := cliHarnessUIDs(0, get); len(got) != 1 || got[0] != 1001 {
		t.Fatalf("root via sudo: %v", got)
	}
	if got := cliHarnessUIDs(1000, get); len(got) != 1 || got[0] != 1000 {
		t.Fatalf("non-root ignores SUDO_UID: %v", got)
	}
	env["SUDO_UID"] = "junk"
	if got := cliHarnessUIDs(0, get); len(got) != 1 || got[0] != 0 {
		t.Fatalf("junk SUDO_UID falls back to euid: %v", got)
	}
}

func TestExplicitUIDsReinstallEvenWhenAlreadySeparateUser(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("separate-user")}}
	res, err := ensure(context.Background(), f, SetupOptions{AgentUIDs: []int{2000}}, rootLinux())
	if err != nil {
		t.Fatal(err)
	}
	if f.installCount() != 1 || f.installs[0].AgentUIDs[0] != 2000 {
		t.Fatalf("installs = %+v", f.installs)
	}
	if !res.Installed || !strings.Contains(res.Notice, "systemctl restart stk") {
		t.Fatalf("result = %+v", res)
	}
	var out bytes.Buffer
	WriteSummary(&out, res)
	if !strings.Contains(out.String(), "systemctl restart stk") {
		t.Fatalf("summary omits the restart note:\n%s", out.String())
	}
}

func TestLazyPathNeverInstallsWhenAlreadySeparateUser(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("separate-user")}}
	// Defaulted uids (none explicit), even as root.
	if _, err := ensure(context.Background(), f, SetupOptions{}, rootLinux(1000)); err != nil {
		t.Fatal(err)
	}
	if f.installCount() != 0 {
		t.Fatal("lazy path must not install over an existing separate-user install")
	}
	// Explicit uids but not root: cannot install, returns the report.
	res, err := ensure(context.Background(), f, SetupOptions{AgentUIDs: []int{5}}, sysEnv{goos: "linux", euid: 1000})
	if err != nil || f.installCount() != 0 || res.Degraded {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestRootAgentUIDIsDegradedAndNotCached(t *testing.T) {
	f := &fakeStk{stateful: true, doctors: []stkclient.DoctorReport{rep("same-user"), rep("separate-user")}}
	res, err := ensure(context.Background(), f, SetupOptions{}, rootLinux(0))
	if err != nil {
		t.Fatal(err)
	}
	if f.installCount() != 1 {
		t.Fatal("the allowlist is still installed")
	}
	const want = "agents run as root; root can read the store"
	if !res.Degraded || !strings.Contains(res.Reason, want) {
		t.Fatalf("result = %+v", res)
	}
	if got := Explain(res.Report, 0); !strings.Contains(got, want) {
		t.Fatalf("Explain = %q", got)
	}
	var out bytes.Buffer
	WriteSummary(&out, res)
	if !strings.Contains(out.String(), "(DEGRADED)") || !strings.Contains(out.String(), want) {
		t.Fatalf("summary:\n%s", out.String())
	}

	// Already installed + lazy path with a root harness uid: also degraded, never cached.
	g := &fakeStk{doctors: []stkclient.DoctorReport{rep("separate-user")}}
	e := newEnsurer(g, SetupOptions{}, rootLinux(0))
	for i := 0; i < 2; i++ {
		r, err := e.Ensure(context.Background())
		if err != nil || !r.Degraded {
			t.Fatalf("call %d: %+v %v", i, r, err)
		}
	}
	if g.doctorCalls != 2 {
		t.Fatalf("root-agent result was cached (doctor calls = %d)", g.doctorCalls)
	}
}

func TestClientIsRebuiltAfterInstallForTheRecheck(t *testing.T) {
	f := &fakeStk{stateful: true, doctors: []stkclient.DoctorReport{rep("same-user"), rep("separate-user")}}
	var installsSeenAtBuild []int
	factory := func() stkclient.Client {
		installsSeenAtBuild = append(installsSeenAtBuild, f.installCount())
		return f
	}
	if _, err := ensureF(context.Background(), factory, SetupOptions{AgentUIDs: []int{1}}, rootLinux()); err != nil {
		t.Fatal(err)
	}
	if n := len(installsSeenAtBuild); n < 2 || installsSeenAtBuild[n-1] != 1 {
		t.Fatalf("builds saw installs %v; the re-check client must be built after install", installsSeenAtBuild)
	}
}

func TestEnsurerPanicDoesNotWedgeLaterCalls(t *testing.T) {
	calls := 0
	e := &Ensurer{run: func(context.Context) (SetupResult, error) {
		calls++
		if calls == 1 {
			panic("boom")
		}
		return SetupResult{Report: rep("separate-user")}, nil
	}}
	// the panic fails that setup (an error), and does not crash the process
	if _, err := e.Ensure(context.Background()); err == nil || !strings.Contains(err.Error(), "panicked") {
		t.Fatalf("first call err = %v", err)
	}
	done := make(chan error, 1)
	go func() { _, err := e.Ensure(context.Background()); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a panic in the first run left the in-flight marker set")
	}
}

// ---- Task 3b: setup for one station's instance ----

func TestSetupPassesInstanceLayoutToInstall(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user"), rep("separate-user")}}
	_, err := ensure(context.Background(), f, SetupOptions{
		ServiceUser: "stk-ab-123456", StateDir: "/var/lib/x/stk-ab-123456", RuntimeDir: "/run/stk-ab-123456",
		ConfigPath: "/etc/x/stk-ab-123456/supertoolkit.yaml", ProxyPort: 8901, UnitName: "stk-ab-123456",
		AgentUIDs: []int{7},
	}, rootLinux())
	if err != nil {
		t.Fatal(err)
	}
	p := f.installs[0]
	if p.RuntimeDir != "/run/stk-ab-123456" || p.ConfigPath != "/etc/x/stk-ab-123456/supertoolkit.yaml" ||
		p.ProxyPort != 8901 || p.UnitName != "stk-ab-123456" {
		t.Fatalf("plan = %+v", p)
	}
}

func TestSetupForceInstallRunsInstallEvenWhenDoctorSaysSeparateUser(t *testing.T) {
	// The doctor of a client that is not bound to an instance yet describes some other store.
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("separate-user")}}
	res, err := ensure(context.Background(), f, SetupOptions{ForceInstall: true, UnitName: "stk-x"}, rootLinux(1001))
	if err != nil || f.installCount() != 1 || !res.Installed {
		t.Fatalf("err=%v installs=%d res=%+v", err, f.installCount(), res)
	}
}

func TestSetupRunsAfterInstallBeforeTheRecheck(t *testing.T) {
	f := &fakeStk{stateful: true, doctors: []stkclient.DoctorReport{rep("same-user"), rep("separate-user")}}
	var order []string
	opts := SetupOptions{AgentUIDs: []int{7}, UnitName: "stk-x", AfterInstall: func(context.Context) error {
		f.mu.Lock()
		order = append(order, "after")
		f.mu.Unlock()
		return nil
	}}
	if _, err := ensure(context.Background(), f, opts, rootLinux()); err != nil {
		t.Fatal(err)
	}
	if len(order) != 1 {
		t.Fatalf("AfterInstall calls = %v", order)
	}
	// A failing hook is reported, scrubbed, and leaves the result degraded.
	f2 := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user")}}
	opts.AfterInstall = func(context.Context) error { return errors.New("systemctl failed " + secretish) }
	res, err := ensure(context.Background(), f2, opts, rootLinux())
	if err == nil || strings.Contains(err.Error(), secretish) || !res.Degraded {
		t.Fatalf("err=%v res=%+v", err, res)
	}
}

func TestSetupMessagesNameTheUnit(t *testing.T) {
	f := &fakeStk{doctors: []stkclient.DoctorReport{rep("same-user"), rep("same-user")}}
	_, err := ensure(context.Background(), f, SetupOptions{AgentUIDs: []int{7}, UnitName: "stk-ab-123456"}, rootLinux())
	if err == nil || !strings.Contains(err.Error(), "systemctl enable --now stk-ab-123456") {
		t.Fatalf("err = %v", err)
	}
}
