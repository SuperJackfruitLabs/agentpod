// Package forgeapi is the node's side of forge API access: it makes sure the
// station has a credential broker (stk) running as its own OS user, so the
// agent can use forge credentials without being able to read them.
package forgeapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

const (
	// LevelSeparateUser is stk's own word for a broker the agent cannot read.
	LevelSeparateUser = "separate-user"

	defaultServiceUser = "stk"
	defaultStkBinary   = "stk"
)

var (
	// ErrNoAgentUID: the allowlist would be empty and no agent could use the broker.
	ErrNoAgentUID = errors.New("cannot determine which uid(s) the agent runs as")
	// ErrUnsupportedPlatform: a separate-user broker needs Linux with systemd.
	ErrUnsupportedPlatform = errors.New("a separate-user stk install needs Linux with systemd")
	// ErrNotSeparateUser: install ran but stk still does not report separate-user.
	ErrNotSeparateUser = errors.New("stk is installed but not reporting separate-user isolation")
)

// SetupOptions configures EnsureStk. Zero values mean defaults.
type SetupOptions struct {
	StkBinary   string // message text only: the Client already knows the path; this is never used to select a binary
	ServiceUser string // OS user stk runs as; default "stk" (group is the same name)
	AgentUIDs   []int  // uids allowed to use the broker; default: the uid the node spawns harnesses as
	StateDir    string // stk state directory; default is stk's own (/var/lib/stk)
	Interactive bool   // informational only (a human is watching); setup behaves identically either way

	// A station's own instance (instances.go) sets these; zero values are stk's defaults.
	RuntimeDir string // directly under /run
	ConfigPath string // the instance's policy file
	ProxyPort  int
	UnitName   string // systemd unit without ".service"; default "stk"
	// ForceInstall runs `stk install` even when the pre-check already says separate-user: the
	// client is not bound to the instance yet (its user does not exist), so that answer describes
	// some other store.
	ForceInstall bool
	// AfterInstall runs once install succeeded, before the isolation re-check: the instance's
	// policy is seeded and its unit started here.
	AfterInstall func(context.Context) error
}

// SetupResult is what setup learned, beyond stk's doctor report.
type SetupResult struct {
	Report    stkclient.DoctorReport
	Installed bool   // this call ran `stk install`
	Degraded  bool   // isolation is anything other than separate-user
	Reason    string // why and how to fix, when Degraded; scrubbed
	Notice    string // something to do next that is not a degradation (e.g. restart the service)
}

const reasonRootAgent = "agents run as root; root can read the store"

func noticeRestart(unit string) string {
	return "the allowlist was written for these agent uid(s); restart the stk service for a changed unit to take effect: `systemctl daemon-reload && systemctl restart " + unit + "`"
}

// sysEnv is what setup needs to know about the machine, injectable for tests.
type sysEnv struct {
	goos        string
	euid        int
	harnessUIDs func() []int
}

func hostEnv() sysEnv {
	return sysEnv{goos: runtime.GOOS, euid: os.Geteuid(), harnessUIDs: NodeHarnessUIDs}
}

// logf is the package logger; tests swap it to prove nothing sensitive is logged.
var logf = log.Printf

// NodeHarnessUIDs is the uid the node spawns harnesses as. The node starts
// every harness with exec and no credential switch, so they inherit its own
// effective uid; this is the single source of truth setup uses by default.
func NodeHarnessUIDs() []int { return []int{os.Geteuid()} }

// CLIHarnessUIDs is the same question asked from `sudo agentpod-node forge-api
// setup`: root is only the installer, the harness uid is the user who ran sudo.
func CLIHarnessUIDs() []int { return cliHarnessUIDs(os.Geteuid(), os.Getenv) }

func cliHarnessUIDs(euid int, getenv func(string) string) []int {
	if euid == 0 {
		if n, err := strconv.Atoi(getenv("SUDO_UID")); err == nil && n > 0 {
			return []int{n}
		}
	}
	return []int{euid}
}

var tokenLike = regexp.MustCompile(`[A-Za-z0-9_\-]{24,}`)

// clean makes stk-provided text safe to show: token-like runs are removed,
// control characters flattened, length capped.
func clean(s string) string {
	s = tokenLike.ReplaceAllString(s, "[redacted]")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if len(s) > 300 {
		s = s[:300] + "..."
	}
	return s
}

type scrubbedError struct {
	msg string
	err error
}

func (e *scrubbedError) Error() string { return e.msg }
func (e *scrubbedError) Unwrap() error { return e.err }

func scrubErr(prefix string, err error) error {
	return &scrubbedError{msg: prefix + ": " + clean(err.Error()), err: err}
}

// Explain says, in one paragraph, why isolation is not separate-user and what
// to do about it. It returns "" when the broker is already separate-user.
func Explain(report stkclient.DoctorReport, euid int) string {
	return explain(report, euid, runtime.GOOS)
}

func explain(report stkclient.DoctorReport, euid int, goos string) string {
	level := report.Isolation.Level
	for _, r := range report.Isolation.Reasons {
		if r == reasonRootAgent {
			return reasonRootAgent + "; the broker's separate user protects nothing from a root agent"
		}
	}
	if level == LevelSeparateUser {
		return ""
	}
	const consequence = "until then the broker runs in same-user mode which gives the agent no protection against reading the store"
	switch {
	case goos != "linux":
		return fmt.Sprintf("this platform (%s) cannot run stk as its own user (Linux with systemd only); the broker stays in same-user mode, which gives the agent no protection against reading the store", goos)
	case euid != 0:
		return "not running as root; run `sudo agentpod-node forge-api setup` once to install stk as its own user; " + consequence
	default:
		return "stk reports isolation " + clean(level) + " although this node is root; run `sudo agentpod-node forge-api setup` and `systemctl enable --now stk`; " + consequence
	}
}

// EnsureStk makes sure stk is present and, when it can, running as its own
// user. It never runs `stk install` twice, never installs without root, and
// never claims more isolation than stk's doctor reports.
func EnsureStk(ctx context.Context, c stkclient.Client, opts SetupOptions) (stkclient.DoctorReport, error) {
	res, err := ensure(ctx, c, opts, hostEnv())
	return res.Report, err
}

// Setup is the CLI entry: it takes a client factory (see ensureF) and returns
// the full result (reason, notice, whether install ran).
func Setup(ctx context.Context, newClient func() stkclient.Client, opts SetupOptions) (SetupResult, error) {
	return ensureF(ctx, newClient, opts, hostEnv())
}

func ensure(ctx context.Context, c stkclient.Client, opts SetupOptions, env sysEnv) (SetupResult, error) {
	return ensureF(ctx, func() stkclient.Client { return c }, opts, env)
}

// ensureF takes a client factory: it is called for the pre-check and again
// after install, so the re-check runs with a client built for the world that
// now exists (the service user, its state directory).
func ensureF(ctx context.Context, newClient func() stkclient.Client, opts SetupOptions, env sysEnv) (SetupResult, error) {
	bin := opts.StkBinary
	if bin == "" {
		bin = defaultStkBinary
	}
	c := newClient()
	if v, err := c.Version(ctx); err == nil {
		if verr := checkStkVersion(v); verr != nil {
			return SetupResult{}, fmt.Errorf("stk at %q: %w; upgrade stk (supertoolkit %s or newer)", bin, verr, MinStkVersion)
		}
	} else {
		switch {
		case errors.Is(err, stkclient.ErrStkMissing):
			return SetupResult{}, fmt.Errorf("stk not found (%q): install stk (supertoolkit, 0.0.1 or newer with the station-service commands) and put it on PATH, then retry: %w", bin, err)
		case errors.Is(err, stkclient.ErrStkTooOld):
			return SetupResult{}, fmt.Errorf("stk at %q is too old: forge API access needs `stk install`, `stk doctor --json` and `stk handover` (supertoolkit station-service slice); upgrade stk: %w", bin, err)
		}
		return SetupResult{}, scrubErr("stk version probe", err)
	}

	rep, err := c.Doctor(ctx)
	if err != nil {
		return SetupResult{}, scrubErr("stk doctor", err)
	}

	explicit := len(opts.AgentUIDs) > 0
	canInstall := env.goos == "linux" && env.euid == 0
	uids := opts.AgentUIDs
	if !explicit && env.harnessUIDs != nil {
		uids = env.harnessUIDs()
	}

	degraded := func(r stkclient.DoctorReport, installed bool) SetupResult {
		r = cleanReport(r)
		return SetupResult{Report: r, Installed: installed, Degraded: true, Reason: explain(r, env.euid, env.goos)}
	}
	// finish labels a protected-looking result honestly when an agent runs as root.
	finish := func(r stkclient.DoctorReport, installed bool, notice string) SetupResult {
		res := SetupResult{Report: cleanReport(r), Installed: installed, Notice: notice}
		if containsUID(uids, 0) {
			res.Report.Isolation.Reasons = append(res.Report.Isolation.Reasons, reasonRootAgent)
			res.Degraded = true
			res.Reason = reasonRootAgent
		}
		return res
	}

	// An existing separate-user install is left alone, except that an explicit
	// allowlist from a root operator is always (re)applied: `stk install` is
	// idempotent and a different --agent-uid set must not be silently ignored.
	if rep.Isolation.Level == LevelSeparateUser && !((explicit || opts.ForceInstall) && canInstall) {
		return finish(rep, false, ""), nil
	}

	if env.goos != "linux" {
		if env.euid == 0 {
			return degraded(rep, false), fmt.Errorf("%w: this platform is %s; stk will run in same-user mode, which gives the agent no protection against reading the store", ErrUnsupportedPlatform, env.goos)
		}
		return degraded(rep, false), nil
	}
	if env.euid != 0 {
		return degraded(rep, false), nil
	}

	if len(uids) == 0 {
		return degraded(rep, false), fmt.Errorf("%w: pass --agent-uid; an empty allowlist would leave no agent able to use the broker", ErrNoAgentUID)
	}
	for _, u := range uids {
		if u < 0 || int64(u) > maxUID {
			return degraded(rep, false), fmt.Errorf("%w: invalid uid %d", ErrNoAgentUID, u)
		}
	}
	user := opts.ServiceUser
	if user == "" {
		user = defaultServiceUser
	}

	unit := opts.UnitName
	if unit == "" {
		unit = "stk"
	}
	logf("forgeapi: installing stk as user %q (unit %s) for agent uid(s) %v", user, unit, uids)
	// Exactly one attempt: a failure is reported, never retried here.
	if _, err := c.Install(ctx, stkclient.InstallPlan{
		User: user, Group: user, AgentUIDs: uids, StateDir: opts.StateDir, RuntimeDir: opts.RuntimeDir,
		ConfigPath: opts.ConfigPath, ProxyPort: opts.ProxyPort, UnitName: opts.UnitName,
	}); err != nil {
		return degraded(rep, false), scrubErr("stk install failed", err)
	}
	if opts.AfterInstall != nil {
		if err := opts.AfterInstall(ctx); err != nil {
			return degraded(rep, true), scrubErr("after stk install", err)
		}
	}

	after, err := newClient().Doctor(ctx)
	if err != nil {
		return degraded(rep, true), scrubErr("stk doctor after install", err)
	}
	if after.Isolation.Level != LevelSeparateUser {
		return degraded(after, true), fmt.Errorf("%w (level %q): start the service with `systemctl enable --now %s`, then run setup again; reasons: %s",
			ErrNotSeparateUser, clean(after.Isolation.Level), unit, clean(strings.Join(after.Isolation.Reasons, "; ")))
	}
	logf("forgeapi: stk isolation is %s (user %q)", after.Isolation.Level, user)
	notice := ""
	if rep.Isolation.Level == LevelSeparateUser {
		notice = noticeRestart(unit)
	}
	return finish(after, true, notice), nil
}

// maxUID is the largest uid Linux accepts (uid_t is 32 bits).
const maxUID = 4294967295

func containsUID(uids []int, want int) bool {
	for _, u := range uids {
		if u == want {
			return true
		}
	}
	return false
}

func cleanReport(r stkclient.DoctorReport) stkclient.DoctorReport {
	out := r
	out.Isolation.Level = clean(r.Isolation.Level)
	out.Isolation.Method = clean(r.Isolation.Method)
	out.Isolation.Reasons = nil
	for _, s := range r.Isolation.Reasons {
		out.Isolation.Reasons = append(out.Isolation.Reasons, clean(s))
	}
	return out
}

// WriteSummary prints isolation level, method and reasons, labelling a
// non-separate-user level as degraded. It prints nothing else from stk.
func WriteSummary(w io.Writer, res SetupResult) {
	iso := res.Report.Isolation
	label := iso.Level
	if res.Degraded {
		label += " (DEGRADED)"
	}
	fmt.Fprintf(w, "isolation: %s\n", label)
	if iso.Method != "" {
		fmt.Fprintf(w, "method:    %s\n", iso.Method)
	}
	for _, r := range iso.Reasons {
		fmt.Fprintf(w, "reason:    %s\n", r)
	}
	if res.Installed {
		fmt.Fprintln(w, "stk was installed by this run")
	}
	if res.Reason != "" {
		fmt.Fprintf(w, "note:      %s\n", res.Reason)
	}
	if res.Notice != "" {
		fmt.Fprintf(w, "next:      %s\n", res.Notice)
	}
}

// Ensurer is the lazy seam the deliver handler calls on every delivery: the
// first call does the work (single-flight across concurrent callers); a
// protected separate-user result is cached. Failures and degraded results
// (including an agent running as root) are not, so a later
// `sudo agentpod-node forge-api setup` is noticed without a restart.
type Ensurer struct {
	run func(context.Context) (SetupResult, error)

	mu       sync.Mutex
	cached   *SetupResult
	inflight *flight
}

type flight struct {
	done chan struct{}
	res  SetupResult
	err  error
}

// NewEnsurer returns the seam for run.go. newClient is called per attempt and
// again after an install.
func NewEnsurer(newClient func() stkclient.Client, opts SetupOptions) *Ensurer {
	return newEnsurerF(newClient, opts, hostEnv())
}

func newEnsurer(c stkclient.Client, opts SetupOptions, env sysEnv) *Ensurer {
	return newEnsurerF(func() stkclient.Client { return c }, opts, env)
}

func newEnsurerF(newClient func() stkclient.Client, opts SetupOptions, env sysEnv) *Ensurer {
	return &Ensurer{run: func(ctx context.Context) (SetupResult, error) {
		return ensureF(ctx, newClient, opts, env)
	}}
}

// Ensure returns the current setup result, running setup at most once at a time.
func (e *Ensurer) Ensure(ctx context.Context) (SetupResult, error) {
	e.mu.Lock()
	if e.cached != nil {
		r := *e.cached
		e.mu.Unlock()
		return r, nil
	}
	if f := e.inflight; f != nil {
		e.mu.Unlock()
		select {
		case <-f.done:
			return f.res, f.err
		case <-ctx.Done():
			return SetupResult{}, ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	e.inflight = f
	e.mu.Unlock()

	e.lead(ctx, f)
	return f.res, f.err
}

// lead runs the work. The deferred cleanup runs even if run panics, so the
// in-flight marker can never wedge later callers.
func (e *Ensurer) lead(ctx context.Context, f *flight) {
	f.err = errors.New("stk setup did not complete")
	defer func() {
		e.mu.Lock()
		e.inflight = nil
		if f.err == nil && !f.res.Degraded && f.res.Report.Isolation.Level == LevelSeparateUser {
			r := f.res
			e.cached = &r
		}
		e.mu.Unlock()
		close(f.done)
	}()
	// The work outlives the first caller's cancellation: others are waiting on it.
	f.res, f.err = e.run(context.WithoutCancel(ctx))
}
