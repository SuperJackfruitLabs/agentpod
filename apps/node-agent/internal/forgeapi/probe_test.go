package forgeapi

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// probeStk scripts only what the capability probe may call. Install and everything else panic
// (nil embedded client), so a probe that tried to install would crash its test.
type probeStk struct {
	stkclient.Client

	mu         sync.Mutex
	version    string
	versionErr error
	doctor     stkclient.DoctorReport
	doctorErr  error
	block      chan struct{} // if set, Doctor ignores ctx and waits on it
	waitCtx    bool          // if set, Doctor blocks until ctx is done
	calls      []string
}

func (s *probeStk) Version(context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "version")
	return s.version, s.versionErr
}

func (s *probeStk) Doctor(ctx context.Context) (stkclient.DoctorReport, error) {
	s.mu.Lock()
	s.calls = append(s.calls, "doctor")
	block, waitCtx, rep, err := s.block, s.waitCtx, s.doctor, s.doctorErr
	s.mu.Unlock()
	if block != nil {
		<-block
	}
	if waitCtx {
		<-ctx.Done()
		return stkclient.DoctorReport{}, ctx.Err()
	}
	return rep, err
}

func (s *probeStk) set(f func(*probeStk)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(s)
}

func okStk() *probeStk {
	return &probeStk{version: "0.0.3", doctor: rep(LevelSeparateUser)}
}

func captureLogs(t *testing.T) *[]string {
	t.Helper()
	var mu sync.Mutex
	var lines []string
	old := logf
	logf = func(f string, a ...any) {
		mu.Lock()
		lines = append(lines, fmt.Sprintf(f, a...))
		mu.Unlock()
	}
	t.Cleanup(func() { logf = old })
	return &lines
}

func probeOf(s stkclient.Client, timeout time.Duration) *CapabilityProbe {
	p := NewCapabilityProbe(func() stkclient.Client { return s }, timeout)
	p.goos, p.euid = "linux", 0 // the machine the capability needs
	return p
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
		err  bool
	}{
		{"0.0.1", "0.0.1", 0, false},
		{"0.0.0", "0.0.1", -1, false},
		{"0.0.2", "0.0.1", 1, false},
		{"0.1.0", "0.0.9", 1, false},
		{"1.0.0", "0.9.9", 1, false},
		{"0.0.10", "0.0.9", 1, false}, // numeric, not lexical
		{"v0.0.1", "0.0.1", 0, false},
		{"V0.0.1", "0.0.1", 0, false},
		{"0.0.1-rc.1", "0.0.1", 0, false}, // pre-release suffix is tolerated: the numeric core decides
		{"0.0.1+build5", "0.0.1", 0, false},
		{"v0.0.2-dev+x", "0.0.1", 1, false},
		{"0.0.0-rc1", "0.0.1", -1, false},
		{" 0.0.1\n", "0.0.1", 0, false},
		{"", "0.0.1", 0, true},
		{"garbage", "0.0.1", 0, true},
		{"1.2", "0.0.1", 0, true},
		{"1.2.3.4", "0.0.1", 0, true},
		{"1.x.3", "0.0.1", 0, true},
		{"-1.0.0", "0.0.1", 0, true},
		{"0.0.99999999999999999999", "0.0.1", 0, true},
		{"v", "0.0.1", 0, true},
	}
	for _, c := range cases {
		got, err := CompareVersions(c.a, c.b)
		if (err != nil) != c.err || (!c.err && got != c.want) {
			t.Errorf("CompareVersions(%q,%q) = %d, %v; want %d, err=%v", c.a, c.b, got, err, c.want, c.err)
		}
	}
}

func TestCheckStkVersion(t *testing.T) {
	if err := checkStkVersion("v0.0.1"); err != nil {
		t.Errorf("0.0.1 is the floor and must pass: %v", err)
	}
	if err := checkStkVersion("0.0.0"); !errors.Is(err, stkclient.ErrStkTooOld) {
		t.Errorf("0.0.0 = %v, want ErrStkTooOld", err)
	}
	if err := checkStkVersion("not-a-version"); !errors.Is(err, stkclient.ErrStkNotRunnable) {
		t.Errorf("garbage = %v, want ErrStkNotRunnable", err)
	}
}

func TestAdvertisesForgeAPIOnlyWithAUsableStk(t *testing.T) {
	boom := errors.New("exec: boom SECRET_ENV_VALUE")
	cases := []struct {
		name       string
		mutate     func(*probeStk)
		wantOK     bool
		wantReason string
	}{
		{"ok", func(*probeStk) {}, true, ""},
		{"ok with v prefix and pre-release", func(s *probeStk) { s.version = "v0.0.1-rc1" }, true, ""},
		{"missing", func(s *probeStk) { s.versionErr = fmt.Errorf("x: %w", stkclient.ErrStkMissing) }, false, "stk-missing"},
		{"too old by --json", func(s *probeStk) { s.versionErr = fmt.Errorf("x: %w", stkclient.ErrStkTooOld) }, false, "stk-too-old"},
		{"too old by version", func(s *probeStk) { s.version = "0.0.0" }, false, "stk-too-old"},
		{"not runnable", func(s *probeStk) { s.versionErr = fmt.Errorf("x: %w", stkclient.ErrStkNotRunnable) }, false, "stk-not-runnable"},
		{"version call fails otherwise", func(s *probeStk) { s.versionErr = boom }, false, "stk-not-runnable"},
		{"version garbage", func(s *probeStk) { s.version = "banana" }, false, "stk-not-runnable"},
		{"doctor unparseable", func(s *probeStk) { s.doctorErr = errors.New("stk doctor: unparseable output") }, false, "stk-not-runnable"},
		{"doctor reports no isolation level", func(s *probeStk) { s.doctor = stkclient.DoctorReport{} }, false, "stk-not-runnable"},
		{"same-user is degraded, not absent", func(s *probeStk) { s.doctor = rep("same-user") }, true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			logs := captureLogs(t)
			s := okStk()
			c.mutate(s)
			p := probeOf(s, time.Second)
			got := p.Refresh(t.Context())
			if got.Available != c.wantOK || got.Reason != c.wantReason {
				t.Fatalf("Refresh = %+v, want available=%v reason=%q", got, c.wantOK, c.wantReason)
			}
			if p.Available() != c.wantOK {
				t.Errorf("Available() = %v after Refresh, want %v", p.Available(), c.wantOK)
			}
			if strings.Contains(strings.Join(*logs, "\n"), "SECRET_ENV_VALUE") {
				t.Errorf("a log line carried stk's error text: %v", *logs)
			}
			for _, call := range s.calls {
				if call != "version" && call != "doctor" {
					t.Errorf("probe called %q", call)
				}
			}
		})
	}
}

func TestProbeIsUnavailableBeforeTheFirstEvaluation(t *testing.T) {
	p := probeOf(okStk(), time.Second)
	if p.Available() {
		t.Fatal("forge.api must not be claimed before stk has been checked")
	}
}

func TestReEvaluatesAfterStkIsInstalled(t *testing.T) {
	captureLogs(t)
	s := okStk()
	s.versionErr = fmt.Errorf("x: %w", stkclient.ErrStkMissing)
	p := probeOf(s, time.Second)
	if got := p.Refresh(t.Context()); got.Available || got.Reason != "stk-missing" {
		t.Fatalf("first = %+v", got)
	}
	// The operator installs stk between two connects.
	s.set(func(s *probeStk) { s.versionErr = nil })
	if got := p.Refresh(t.Context()); !got.Available {
		t.Fatalf("second = %+v, want available once stk is installed", got)
	}
	if !p.Available() {
		t.Fatal("Available() still reports the stale value")
	}
	// And removed again.
	s.set(func(s *probeStk) { s.versionErr = fmt.Errorf("x: %w", stkclient.ErrStkMissing) })
	if p.Refresh(t.Context()); p.Available() {
		t.Fatal("capability must be withdrawn when stk disappears")
	}
}

func TestProbeTimeoutDoesNotHang(t *testing.T) {
	logs := captureLogs(t)
	s := okStk()
	s.waitCtx = true
	p := probeOf(s, 80*time.Millisecond)
	start := time.Now()
	got := p.Refresh(t.Context())
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("probe took %v", d)
	}
	if got.Available || got.Reason != "stk-not-runnable" {
		t.Fatalf("a timed out probe = %+v, want unavailable", got)
	}
	if len(*logs) != 1 || !strings.Contains((*logs)[0], "timed out") {
		t.Errorf("logs = %v, want exactly one timeout line", *logs)
	}
}

// A client that ignores its context entirely must still not block the connect path.
func TestProbeTimeoutHoldsEvenWhenTheClientIgnoresItsContext(t *testing.T) {
	captureLogs(t)
	s := okStk()
	s.block = make(chan struct{})
	t.Cleanup(func() { close(s.block) })
	p := probeOf(s, 80*time.Millisecond)
	done := make(chan Availability, 1)
	go func() { done <- p.Refresh(t.Context()) }()
	select {
	case got := <-done:
		if got.Available {
			t.Fatalf("got %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Refresh blocked on a client that ignores ctx")
	}
}

func TestProbeHonoursTheCallersCancellation(t *testing.T) {
	captureLogs(t)
	s := okStk()
	s.waitCtx = true
	p := probeOf(s, time.Minute)
	ctx, cancel := context.WithCancel(t.Context())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	done := make(chan struct{})
	go func() { p.Refresh(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Refresh ignored cancellation")
	}
}

func TestProbeLogsOnlyTheReasonAndVersionAndOnlyOnChange(t *testing.T) {
	logs := captureLogs(t)
	s := okStk()
	s.versionErr = fmt.Errorf("stk version: %w (TOKEN=SECRET_ENV_VALUE)", stkclient.ErrStkNotRunnable)
	p := probeOf(s, time.Second)
	for i := 0; i < 3; i++ {
		p.Refresh(t.Context())
	}
	if len(*logs) != 1 {
		t.Fatalf("an unchanged outcome must log once, got %v", *logs)
	}
	s.set(func(s *probeStk) { s.versionErr = nil })
	p.Refresh(t.Context())
	p.Refresh(t.Context())
	if len(*logs) != 2 {
		t.Fatalf("a change logs once more, got %v", *logs)
	}
	all := strings.Join(*logs, "\n")
	if strings.Contains(all, "SECRET_ENV_VALUE") || strings.Contains(all, "TOKEN") {
		t.Errorf("logs leak error text: %s", all)
	}
	if !strings.Contains((*logs)[0], "stk-not-runnable") || !strings.Contains((*logs)[1], "0.0.3") {
		t.Errorf("logs = %v, want the reason code then the version", *logs)
	}
}

func TestProbeNeverInstalls(t *testing.T) {
	captureLogs(t)
	var installs atomic.Int32
	s := &installCounter{probeStk: okStk(), installs: &installs}
	s.probeStk.versionErr = fmt.Errorf("x: %w", stkclient.ErrStkMissing)
	probeOf(s, time.Second).Refresh(t.Context())
	if installs.Load() != 0 {
		t.Fatal("the capability probe ran stk install")
	}
}

type installCounter struct {
	*probeStk
	installs *atomic.Int32
}

func (i *installCounter) Install(context.Context, stkclient.InstallPlan) (stkclient.InstallReport, error) {
	i.installs.Add(1)
	return stkclient.InstallReport{}, nil
}

func TestProbeWithholdsTheCapabilityWithoutRootOnLinux(t *testing.T) {
	for _, c := range []struct {
		goos   string
		euid   int
		reason string
	}{{"linux", 1000, "not-root"}, {"darwin", 0, "unsupported-platform"}, {"windows", 0, "unsupported-platform"}} {
		s := okStk() // stk itself is fine; the machine is not
		p := probeOf(s, time.Second)
		p.goos, p.euid = c.goos, c.euid
		a := p.Refresh(context.Background())
		if a.Available || a.Reason != c.reason || p.Available() {
			t.Errorf("%s uid %d: %+v", c.goos, c.euid, a)
		}
	}
	p := probeOf(okStk(), time.Second)
	if !p.Refresh(context.Background()).Available {
		t.Error("root on linux with a good stk must be available")
	}
}
