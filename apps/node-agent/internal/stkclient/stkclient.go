// Package stkclient wraps the stk CLI (supertoolkit) behind an interface.
package stkclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrStkMissing     = errors.New("stk binary not found")
	ErrStkTooOld      = errors.New("stk is too old (no --json support)")
	ErrStkNotRunnable = errors.New("stk binary is not runnable by this user")
)

const (
	outputCap      = 64 * 1024
	stderrInError  = 200
	defaultTimeout = 30 * time.Second
)

type Runner func(ctx context.Context, name string, args []string, stdin []byte, env []string) (stdout []byte, stderr []byte, exitCode int, err error)

type Options struct {
	Env     map[string]string
	RunAs   string
	Timeout time.Duration
	Run     Runner

	geteuid func() int
}

type Client interface {
	Version(ctx context.Context) (string, error)
	HandoverKey(ctx context.Context) (string, error)
	HandoverOpen(ctx context.Context, service, envelope string) error
	Verify(ctx context.Context, service, expectLogin string) (VerifyResult, error)
	Reload(ctx context.Context) (ReloadResult, error)
	RevokeLocal(ctx context.Context, service string) error
	Env(ctx context.Context) (Env, error)
	Doctor(ctx context.Context) (DoctorReport, error)
	Probe(ctx context.Context) ([]ProbeOutcome, error)
	Install(ctx context.Context, p InstallPlan) (InstallReport, error)
}

type VerifyResult struct {
	OK            bool
	Login, Reason string
}

type ReloadResult struct {
	OK                      bool
	Removed, Added, Changed []string
	Error                   string
}

type Env struct {
	ProxyURL, CAPath string
	Vars             map[string]string
}

type Check struct {
	Name   string
	OK     bool
	Warn   bool
	Detail string
}

type Isolation struct {
	Level, Method string
	Reasons       []string
}

type DoctorReport struct {
	Checks    []Check
	Isolation Isolation
}

type ProbeOutcome struct{ Client, Outcome, Detail string }

type InstallPlan struct {
	User, Group, StateDir, RuntimeDir, ConfigPath string
	AgentUIDs                                     []int
	ProxyPort                                     int
	DryRun                                        bool
}

// InstallReport carries the capped, scrubbed text `stk install` prints.
type InstallReport struct{ Output string }

// capBuffer keeps the first outputCap bytes and silently discards the rest,
// so a chatty child never blocks on a full pipe.
type capBuffer struct{ buf bytes.Buffer }

func (c *capBuffer) Write(p []byte) (int, error) {
	if room := outputCap - c.buf.Len(); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		c.buf.Write(p[:room])
	}
	return len(p), nil
}

// DefaultRunner executes name with an argument vector (no shell), exactly the
// given environment (nothing inherited), stdout and stderr each capped at
// 64 KiB, and kills the child's process group when ctx ends.
func DefaultRunner(ctx context.Context, name string, args []string, stdin []byte, env []string) ([]byte, []byte, int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append([]string{}, env...)
	if cmd.Env == nil {
		cmd.Env = []string{}
	}
	if len(stdin) > 0 {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out, errb capBuffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	ownProcessGroup(cmd)
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.buf.Bytes(), errb.buf.Bytes(), ee.ExitCode(), nil
	}
	if err != nil {
		return out.buf.Bytes(), errb.buf.Bytes(), -1, err
	}
	return out.buf.Bytes(), errb.buf.Bytes(), 0, nil
}

type client struct {
	bin  string
	opts Options
}

// New returns a Client that runs the stk binary at binary.
func New(binary string, opts Options) Client {
	if opts.Run == nil {
		opts.Run = DefaultRunner
	}
	if opts.Timeout <= 0 {
		opts.Timeout = defaultTimeout
	}
	if opts.geteuid == nil {
		opts.geteuid = os.Geteuid
	}
	return &client{bin: binary, opts: opts}
}

var tokenLike = regexp.MustCompile(`[A-Za-z0-9_\-]{24,}`)

// scrub removes every value this client was handed (stdin, env) and anything
// that looks like a token, strips control characters, and truncates to max
// bytes on a rune boundary.
func (c *client) scrub(s string, stdin []byte, max int) string {
	secrets := make([]string, 0, len(c.opts.Env)+1)
	if len(stdin) > 0 {
		secrets = append(secrets, strings.TrimSpace(string(stdin)))
	}
	for _, v := range c.opts.Env {
		secrets = append(secrets, v)
	}
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	for _, sec := range secrets {
		if len(sec) >= 3 {
			s = strings.ReplaceAll(s, sec, "[redacted]")
		}
	}
	s = tokenLike.ReplaceAllString(s, "[redacted]")
	s = strings.Map(func(r rune) rune {
		if r == '\n' && max <= 0 {
			return r
		}
		if r == '\n' || r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if max > 0 && len(s) > max {
		s = s[:max]
		for !utf8.ValidString(s) && len(s) > 0 {
			s = s[:len(s)-1]
		}
		s += "..."
	}
	return s
}

func (c *client) environ() []string {
	env := []string{"PATH=" + os.Getenv("PATH")}
	keys := make([]string, 0, len(c.opts.Env))
	for k := range c.opts.Env {
		if k != "PATH" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		env = append(env, k+"="+c.opts.Env[k])
	}
	return env
}

var tooOldMarkers = []string{"unknown argument", "unknown flag", "flag provided but not defined", "unknown option", "unknown command"}

type result struct {
	stdout []byte
	code   int
}

// run executes one stk subcommand. A non-zero exit is NOT an error here:
// some subcommands report a result on stdout and exit non-zero. Callers that
// need success check code themselves via fail().
func (c *client) run(ctx context.Context, sub string, args []string, stdin []byte) (result, string, error) {
	if c.opts.RunAs != "" && strings.HasPrefix(c.opts.RunAs, "-") {
		return result{}, "", fmt.Errorf("stk %s: invalid RunAs user", sub)
	}
	name, full := c.bin, args
	if c.opts.RunAs != "" && c.opts.geteuid() == 0 {
		name = "runuser"
		full = append([]string{"-u", c.opts.RunAs, "--", c.bin}, args...)
	}
	cctx, cancel := context.WithTimeout(ctx, c.opts.Timeout)
	defer cancel()
	stdout, stderr, code, err := c.opts.Run(cctx, name, full, stdin, c.environ())
	if cctx.Err() != nil {
		return result{}, "", fmt.Errorf("stk %s: timed out after %s", sub, c.opts.Timeout)
	}
	if err != nil {
		switch {
		case errors.Is(err, exec.ErrNotFound), errors.Is(err, fs.ErrNotExist):
			return result{}, "", fmt.Errorf("stk %s: %w", sub, ErrStkMissing)
		case errors.Is(err, fs.ErrPermission):
			return result{}, "", fmt.Errorf("stk %s: %w", sub, ErrStkNotRunnable)
		}
		return result{}, "", fmt.Errorf("stk %s: could not run: %s", sub, c.scrub(err.Error(), stdin, stderrInError))
	}
	switch code {
	case 127:
		return result{}, "", fmt.Errorf("stk %s: %w", sub, ErrStkMissing)
	case 126:
		return result{}, "", fmt.Errorf("stk %s: %w", sub, ErrStkNotRunnable)
	}
	se := string(stderr)
	if code != 0 {
		low := strings.ToLower(se)
		for _, m := range tooOldMarkers {
			if strings.Contains(low, m) {
				for _, a := range args {
					if a == "--json" {
						return result{}, "", fmt.Errorf("stk %s: %w", sub, ErrStkTooOld)
					}
				}
			}
		}
	}
	return result{stdout: stdout, code: code}, c.scrub(se, stdin, stderrInError), nil
}

func failure(sub string, code int, scrubbedStderr string) error {
	if scrubbedStderr == "" {
		return fmt.Errorf("stk %s: exit %d", sub, code)
	}
	return fmt.Errorf("stk %s: exit %d: %s", sub, code, scrubbedStderr)
}

func badOutput(sub string, code int, scrubbedStderr string) error {
	msg := fmt.Sprintf("stk %s: unparseable or incomplete output (exit %d)", sub, code)
	if code != 0 && scrubbedStderr != "" {
		msg += ": " + scrubbedStderr
	}
	return errors.New(msg)
}

// call runs a subcommand that must exit zero.
func (c *client) call(ctx context.Context, sub string, args []string, stdin []byte) ([]byte, error) {
	r, se, err := c.run(ctx, sub, args, stdin)
	if err != nil {
		return nil, err
	}
	if r.code != 0 {
		return nil, failure(sub, r.code, se)
	}
	return r.stdout, nil
}

func checkService(sub, service string) error {
	if service == "" || strings.HasPrefix(service, "-") {
		return fmt.Errorf("stk %s: invalid service name", sub)
	}
	return nil
}

func (c *client) Version(ctx context.Context) (string, error) {
	out, err := c.call(ctx, "version", []string{"version"}, nil)
	if err != nil {
		return "", err
	}
	v := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), "stk "))
	if v == "" || strings.ContainsAny(v, "\r\n") {
		return "", errors.New("stk version: unparseable output")
	}
	return v, nil
}

func (c *client) HandoverKey(ctx context.Context) (string, error) {
	out, err := c.call(ctx, "handover key", []string{"handover", "key", "--json"}, nil)
	if err != nil {
		return "", err
	}
	var d struct {
		PublicKey *string `json:"public_key"`
	}
	if json.Unmarshal(out, &d) != nil || d.PublicKey == nil || *d.PublicKey == "" {
		return "", badOutput("handover key", 0, "")
	}
	return *d.PublicKey, nil
}

// HandoverOpen passes the envelope on stdin only.
func (c *client) HandoverOpen(ctx context.Context, service, envelope string) error {
	if err := checkService("handover open", service); err != nil {
		return err
	}
	out, err := c.call(ctx, "handover open", []string{"handover", "open", service, "--json"}, []byte(envelope))
	if err != nil {
		return err
	}
	var d struct {
		Stored *bool `json:"stored"`
	}
	if json.Unmarshal(out, &d) != nil || d.Stored == nil || !*d.Stored {
		return badOutput("handover open", 0, "")
	}
	return nil
}

// Verify parses stdout whatever the exit code: stk exits non-zero on a failed
// verification but still writes the JSON result.
func (c *client) Verify(ctx context.Context, service, expectLogin string) (VerifyResult, error) {
	if err := checkService("verify", service); err != nil {
		return VerifyResult{}, err
	}
	args := []string{"verify", service}
	if expectLogin != "" {
		args = append(args, "--expect-login", expectLogin)
	}
	args = append(args, "--json")
	r, se, err := c.run(ctx, "verify", args, nil)
	if err != nil {
		return VerifyResult{}, err
	}
	var d struct {
		OK     *bool  `json:"ok"`
		Login  string `json:"login"`
		Reason string `json:"reason"`
	}
	if json.Unmarshal(r.stdout, &d) != nil || d.OK == nil {
		return VerifyResult{}, badOutput("verify", r.code, se)
	}
	return VerifyResult{OK: *d.OK, Login: d.Login, Reason: d.Reason}, nil
}

// Reload returns stk's own verdict: {"ok":false,"error":...} is a result, not
// a Go error. A non-zero exit that claims ok is an error.
func (c *client) Reload(ctx context.Context) (ReloadResult, error) {
	r, se, err := c.run(ctx, "reload", []string{"reload", "--json"}, nil)
	if err != nil {
		return ReloadResult{}, err
	}
	var d struct {
		OK      *bool    `json:"ok"`
		Removed []string `json:"removed"`
		Added   []string `json:"added"`
		Changed []string `json:"changed"`
		Error   string   `json:"error"`
	}
	if json.Unmarshal(r.stdout, &d) != nil || d.OK == nil {
		return ReloadResult{}, badOutput("reload", r.code, se)
	}
	if r.code != 0 && *d.OK {
		return ReloadResult{}, failure("reload", r.code, se)
	}
	return ReloadResult{OK: *d.OK, Removed: d.Removed, Added: d.Added, Changed: d.Changed, Error: c.scrub(d.Error, nil, 400)}, nil
}

func (c *client) RevokeLocal(ctx context.Context, service string) error {
	if err := checkService("revoke", service); err != nil {
		return err
	}
	_, err := c.call(ctx, "revoke", []string{"revoke", service, "--local"}, nil)
	return err
}

func (c *client) Env(ctx context.Context) (Env, error) {
	out, err := c.call(ctx, "env", []string{"env", "--json"}, nil)
	if err != nil {
		return Env{}, err
	}
	var d struct {
		ProxyURL string            `json:"proxy_url"`
		CAPath   string            `json:"ca_path"`
		Env      map[string]string `json:"env"`
	}
	if json.Unmarshal(out, &d) != nil || d.ProxyURL == "" || d.CAPath == "" {
		return Env{}, badOutput("env", 0, "")
	}
	if d.Env == nil {
		d.Env = map[string]string{}
	}
	return Env{ProxyURL: d.ProxyURL, CAPath: d.CAPath, Vars: d.Env}, nil
}

func (c *client) Doctor(ctx context.Context) (DoctorReport, error) {
	out, err := c.call(ctx, "doctor", []string{"doctor", "--json"}, nil)
	if err != nil {
		return DoctorReport{}, err
	}
	var d struct {
		Checks []struct {
			Name   string `json:"name"`
			OK     bool   `json:"ok"`
			Warn   bool   `json:"warn"`
			Detail string `json:"detail"`
		} `json:"checks"`
		Isolation struct {
			Level   string   `json:"level"`
			Method  string   `json:"method"`
			Reasons []string `json:"reasons"`
		} `json:"isolation"`
	}
	if json.Unmarshal(out, &d) != nil || d.Isolation.Level == "" {
		return DoctorReport{}, badOutput("doctor", 0, "")
	}
	rep := DoctorReport{Isolation: Isolation{Level: d.Isolation.Level, Method: d.Isolation.Method, Reasons: d.Isolation.Reasons}}
	for _, ch := range d.Checks {
		rep.Checks = append(rep.Checks, Check{Name: ch.Name, OK: ch.OK, Warn: ch.Warn, Detail: ch.Detail})
	}
	return rep, nil
}

// Probe parses stdout whatever the exit code (non-zero on bypass or when
// nothing was honoured).
func (c *client) Probe(ctx context.Context) ([]ProbeOutcome, error) {
	r, se, err := c.run(ctx, "doctor --probe", []string{"doctor", "--probe", "--json"}, nil)
	if err != nil {
		return nil, err
	}
	var d []struct {
		Client  string `json:"client"`
		Outcome string `json:"outcome"`
		Detail  string `json:"detail"`
	}
	if json.Unmarshal(r.stdout, &d) != nil || d == nil {
		return nil, badOutput("doctor --probe", r.code, se)
	}
	res := make([]ProbeOutcome, 0, len(d))
	for _, p := range d {
		if p.Client == "" || p.Outcome == "" {
			return nil, badOutput("doctor --probe", r.code, se)
		}
		res = append(res, ProbeOutcome{Client: p.Client, Outcome: p.Outcome, Detail: p.Detail})
	}
	return res, nil
}

func (c *client) Install(ctx context.Context, p InstallPlan) (InstallReport, error) {
	if p.User == "" || strings.HasPrefix(p.User, "-") {
		return InstallReport{}, errors.New("stk install: invalid user")
	}
	args := []string{"install", "--user", p.User}
	add := func(flag, val string) {
		if val != "" {
			args = append(args, flag, val)
		}
	}
	add("--group", p.Group)
	add("--state-dir", p.StateDir)
	add("--runtime-dir", p.RuntimeDir)
	add("--config", p.ConfigPath)
	for _, uid := range p.AgentUIDs {
		args = append(args, "--agent-uid", strconv.Itoa(uid))
	}
	if p.ProxyPort != 0 {
		args = append(args, "--proxy-port", strconv.Itoa(p.ProxyPort))
	}
	if p.DryRun {
		args = append(args, "--dry-run")
	}
	out, err := c.call(ctx, "install", args, nil)
	if err != nil {
		return InstallReport{}, err
	}
	return InstallReport{Output: c.scrub(string(out), nil, 0)}, nil
}
