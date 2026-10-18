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
	StkBinary   string // only used in messages; the Client already knows the path
	ServiceUser string // OS user stk runs as; default "stk" (group is the same name)
	AgentUIDs   []int  // uids allowed to use the broker; default: the uid the node spawns harnesses as
	StateDir    string // stk state directory; default is stk's own (/var/lib/stk)
	Interactive bool   // a human is watching (the CLI); callers use it to decide how much to print
}

// SetupResult is what setup learned, beyond stk's doctor report.
type SetupResult struct {
	Report    stkclient.DoctorReport
	Installed bool   // this call ran `stk install`
	Degraded  bool   // isolation is anything other than separate-user
	Reason    string // why and how to fix, when Degraded; scrubbed
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

// Setup is EnsureStk with the full result (reason, whether install ran).
func Setup(ctx context.Context, c stkclient.Client, opts SetupOptions) (SetupResult, error) {
	return ensure(ctx, c, opts, hostEnv())
}

func ensure(ctx context.Context, c stkclient.Client, opts SetupOptions, env sysEnv) (SetupResult, error) {
	bin := opts.StkBinary
	if bin == "" {
		bin = defaultStkBinary
	}
	if _, err := c.Version(ctx); err != nil {
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
	if rep.Isolation.Level == LevelSeparateUser {
		return SetupResult{Report: cleanReport(rep)}, nil
	}

	degraded := func(r stkclient.DoctorReport, installed bool) SetupResult {
		r = cleanReport(r)
		return SetupResult{Report: r, Installed: installed, Degraded: true, Reason: explain(r, env.euid, env.goos)}
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

	uids := opts.AgentUIDs
	if len(uids) == 0 && env.harnessUIDs != nil {
		uids = env.harnessUIDs()
	}
	if len(uids) == 0 {
		return degraded(rep, false), fmt.Errorf("%w: pass --agent-uid; an empty allowlist would leave no agent able to use the broker", ErrNoAgentUID)
	}
	for _, u := range uids {
		if u < 0 {
			return degraded(rep, false), fmt.Errorf("%w: invalid uid %d", ErrNoAgentUID, u)
		}
	}
	user := opts.ServiceUser
	if user == "" {
		user = defaultServiceUser
	}

	logf("forgeapi: installing stk as user %q for agent uid(s) %v", user, uids)
	// Exactly one attempt: a failure is reported, never retried here.
	if _, err := c.Install(ctx, stkclient.InstallPlan{User: user, Group: user, AgentUIDs: uids, StateDir: opts.StateDir}); err != nil {
		return degraded(rep, false), scrubErr("stk install failed", err)
	}

	after, err := c.Doctor(ctx)
	if err != nil {
		return degraded(rep, true), scrubErr("stk doctor after install", err)
	}
	if after.Isolation.Level != LevelSeparateUser {
		return degraded(after, true), fmt.Errorf("%w (level %q): start the service with `systemctl enable --now stk`, then run setup again; reasons: %s",
			ErrNotSeparateUser, clean(after.Isolation.Level), clean(strings.Join(after.Isolation.Reasons, "; ")))
	}
	logf("forgeapi: stk isolation is %s (user %q)", after.Isolation.Level, user)
	return SetupResult{Report: cleanReport(after), Installed: true}, nil
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
}

// Ensurer is the lazy seam the deliver handler calls on every delivery: the
// first call does the work (single-flight across concurrent callers); a
// separate-user result is cached. Failures and degraded results are not, so a
// later `sudo agentpod-node forge-api setup` is noticed without a restart.
type Ensurer struct {
	run func(context.Context) (stkclient.DoctorReport, error)

	mu       sync.Mutex
	cached   *stkclient.DoctorReport
	inflight *flight
}

type flight struct {
	done chan struct{}
	rep  stkclient.DoctorReport
	err  error
}

// NewEnsurer returns the seam for run.go.
func NewEnsurer(c stkclient.Client, opts SetupOptions) *Ensurer {
	return newEnsurer(c, opts, hostEnv())
}

func newEnsurer(c stkclient.Client, opts SetupOptions, env sysEnv) *Ensurer {
	return &Ensurer{run: func(ctx context.Context) (stkclient.DoctorReport, error) {
		res, err := ensure(ctx, c, opts, env)
		return res.Report, err
	}}
}

// Ensure returns the current doctor report, running setup at most once at a time.
func (e *Ensurer) Ensure(ctx context.Context) (stkclient.DoctorReport, error) {
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
			return f.rep, f.err
		case <-ctx.Done():
			return stkclient.DoctorReport{}, ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	e.inflight = f
	e.mu.Unlock()

	// The work outlives the first caller's cancellation: others are waiting on it.
	f.rep, f.err = e.run(context.WithoutCancel(ctx))

	e.mu.Lock()
	e.inflight = nil
	if f.err == nil && f.rep.Isolation.Level == LevelSeparateUser {
		r := f.rep
		e.cached = &r
	}
	e.mu.Unlock()
	close(f.done)
	return f.rep, f.err
}
