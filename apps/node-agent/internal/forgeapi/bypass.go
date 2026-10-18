package forgeapi

// The bypass check: does a client on the station's machine go through the station's broker?
//
// A client that ignores the proxy configuration fails SILENTLY: it reaches the provider with a
// worthless placeholder and gets a plausible 401 back, which looks like a credential problem and
// not a routing one. So verify does not stop at "the credential works"; it also reports, per
// client, whether the client was seen going through the broker.
//
// Two sources of evidence, both measured against a LOCAL stand-in and never a real forge:
//   - stk's own probe (`stk doctor --probe --json`, stkclient.Probe) drives curl, python3, node and
//     a default Go client through a throw-away broker in front of a local provider at a host that
//     can never resolve, so a client that does not use the proxy is proven to, not guessed to.
//     It is run through THIS station's client (its own stk instance, its own environment).
//   - the station's harness client itself, where a safe non-interactive probe command exists
//     (ExecRunner). None is shipped: no harness the registry knows has a command that makes one
//     request to a given URL without also talking to its model provider, so by default the
//     harness is reported `untested`, never `honoured`. A probe is added by configuring
//     InstancesConfig.HarnessProbes.
//
// Outcomes are a fixed vocabulary. Nothing stk or a runner says in free text travels onward: a
// probe's detail can quote a server's reply, and the hub shows what it receives to operators.

import (
	"context"
	"errors"
	"net"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// The five outcomes a client can have.
const (
	OutcomeHonoured  = "honoured"
	OutcomeBypassed  = "bypassed"
	OutcomeRefusedCA = "refused-ca"
	OutcomeUntested  = "untested"
	OutcomeFailed    = "failed"
)

// ProbeHost is the host stk's probe serves its local stand-in at. It is in the .invalid TLD, which
// RFC 2606 guarantees never resolves, so a client that reaches it by itself fails.
const ProbeHost = "probe.supertoolkit.invalid"

// ClientOutcome is one client's verdict.
type ClientOutcome struct {
	Client  string `json:"client"`
	Outcome string `json:"outcome"`
}

// ClientRunner runs the probe of a harness's own client. known=false means there is no probe for
// the harness (reported `untested`). An error is reported `failed`; its text is never forwarded.
type ClientRunner func(ctx context.Context, harness string) (outcome string, known bool, err error)

// stkProbeTimeout bounds stk's probe (it starts a broker and four clients).
var stkProbeTimeout = 60 * time.Second

// harnessProbeTimeout bounds one harness probe.
var harnessProbeTimeout = 10 * time.Second

// mapProbeOutcome maps what a probe says onto the vocabulary. stk's `missing` (the client is not
// installed here) is `untested`: nothing was measured. Anything not exactly one of the known words
// is `failed`, so a newer stk, or a hostile one, can never produce a pass.
func mapProbeOutcome(s string) string {
	switch s {
	case "honoured":
		return OutcomeHonoured
	case "bypassed":
		return OutcomeBypassed
	case "refused-ca":
		return OutcomeRefusedCA
	case "missing":
		return OutcomeUntested
	}
	return OutcomeFailed
}

var clientNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._/+-]{0,63}$`)

// cleanClient keeps a client's name only when it looks like one.
func cleanClient(s string) string {
	if clientNameRE.MatchString(s) {
		return s
	}
	return "unknown-client"
}

// CheckBypass reports, for the station behind c, which clients went through its broker. harness
// names the station's harness ("" for none); run probes the harness's own client and may be nil.
func CheckBypass(ctx context.Context, c stkclient.Client, harness string, run ClientRunner) []ClientOutcome {
	var out []ClientOutcome
	pctx, cancel := context.WithTimeout(ctx, stkProbeTimeout)
	rows, err := c.Probe(pctx)
	cancel()
	switch {
	case err != nil:
		out = append(out, ClientOutcome{Client: "stk-probe", Outcome: OutcomeFailed})
	case len(rows) == 0:
		out = append(out, ClientOutcome{Client: "stk-probe", Outcome: OutcomeUntested})
	default:
		for _, r := range rows {
			// Only the client and the outcome are read; the detail is free text from stk.
			out = append(out, ClientOutcome{Client: cleanClient(r.Client), Outcome: mapProbeOutcome(r.Outcome)})
		}
	}
	if harness != "" {
		out = append(out, ClientOutcome{Client: cleanClient(harness), Outcome: runHarnessProbe(ctx, harness, run)})
	}
	return out
}

// runHarnessProbe is bounded in time even if the runner ignores its context, and a runner that
// answers after the deadline is not believed.
func runHarnessProbe(ctx context.Context, harness string, run ClientRunner) string {
	if run == nil {
		return OutcomeUntested
	}
	rctx, cancel := context.WithTimeout(ctx, harnessProbeTimeout)
	defer cancel()
	type result struct {
		outcome string
		known   bool
		err     error
	}
	ch := make(chan result, 1)
	go func() {
		defer func() {
			if recover() != nil {
				ch <- result{err: errors.New("panic")}
			}
		}()
		o, k, e := run(rctx, harness)
		ch <- result{o, k, e}
	}()
	select {
	case <-rctx.Done():
		return OutcomeFailed
	case r := <-ch:
		switch {
		case rctx.Err() != nil || r.err != nil:
			return OutcomeFailed
		case !r.known:
			return OutcomeUntested
		}
		return mapProbeOutcome(r.outcome)
	}
}

// ---- what the verify ack carries ----

// BypassPath is one way the station's harness reaches the network, and whether the node routed it
// through the station's broker. Wired is the node's own record of what it did, not a measurement.
type BypassPath struct {
	Path   string   `json:"path"` // "spawn" (sessions and terminals the node starts) or "gateway" (a long-lived unit)
	Wired  bool     `json:"wired"`
	Units  []string `json:"units,omitempty"`
	Reason string   `json:"reason,omitempty"` // why it is not wired; names only
}

// BypassReport is the `bypass` field of the verify ack.
type BypassReport struct {
	// Clients: the measured outcomes (stk's generic clients, then the station's harness).
	Clients []ClientOutcome `json:"clients"`
	Harness string          `json:"harness,omitempty"`
	// Paths is the coverage the node claims. Brokered is true only when every path is wired and
	// nothing blocks the wiring: a reader must not assume brokered coverage beyond it.
	Paths    []BypassPath `json:"paths,omitempty"`
	Brokered bool         `json:"brokered"`
	// WiringBlocked is why a path is not routed (a proxy variable the harness already sets).
	WiringBlocked string `json:"wiringBlocked,omitempty"`
}

// bypassedClients lists the clients seen bypassing the broker.
func (r *BypassReport) bypassedClients() []string {
	var out []string
	if r == nil {
		return nil
	}
	for _, c := range r.Clients {
		if c.Outcome == OutcomeBypassed {
			out = append(out, c.Client)
		}
	}
	return out
}

// applyBypass makes a bypass a failure of the verify, without hiding a failure stk already
// reported: the hub reads the first token of `reason`. `bypassed` is not one of stk's codes, so a
// hub that does not know it treats the verify as inconclusive, never as verified.
func (a *VerifyAck) applyBypass() {
	if !a.OK {
		return
	}
	if b := a.Bypass.bypassedClients(); len(b) > 0 {
		a.OK = false
		a.Reason = "bypassed: " + strings.Join(b, ", ")
	}
}

// applyCoverage: a station whose harness reaches the forge by no brokered path has nothing the
// credential protects, however well the generic clients behave. OK is false with `not-wired`.
func (a *VerifyAck) applyCoverage() {
	if !a.OK || a.Bypass == nil {
		return
	}
	for _, p := range a.Bypass.Paths {
		if p.Wired {
			return
		}
	}
	a.OK = false
	a.Reason = "not-wired: no path of this station's harness is routed through its broker"
	if a.Bypass.WiringBlocked != "" {
		a.Reason += " (" + a.Bypass.WiringBlocked + ")"
	}
}

// ---- running a harness's own client ----

// ExecRunner is the production ClientRunner. For a harness with a configured probe command it
// runs it under the STATION's broker environment and nothing else: the node's own environment
// (its hub token, its cloud credentials, its proxy) never reaches the command. The command may name
// only the local stand-in (ProbeHost, localhost or a loopback address), and the station's proxy
// must be a loopback address; otherwise nothing is run.
//
// The command prints one outcome word (honoured|bypassed|refused-ca) as its first line.
type ExecRunner struct {
	// Probes: harness -> argv. A harness not in it is not known (`untested`).
	Probes map[string][]string
	// Env returns the station's broker environment (BrokerEnv of the station's own instance).
	Env func(context.Context) (map[string]string, error)
	// Exec runs argv with exactly env and returns its stdout; nil means a real process.
	Exec    func(ctx context.Context, argv, env []string) (string, error)
	Timeout time.Duration
}

// probeEnvAllowed is what of the station's environment a probe may see: the proxy and the CA
// variables that route a client through the broker. Placeholders for credentials are not needed
// and are not passed.
var probeEnvAllowed = map[string]bool{
	"HTTPS_PROXY": true, "https_proxy": true, "HTTP_PROXY": true, "http_proxy": true,
	"SSL_CERT_FILE": true, "CURL_CA_BUNDLE": true, "REQUESTS_CA_BUNDLE": true,
	"NODE_EXTRA_CA_CERTS": true, "NODE_USE_ENV_PROXY": true, "STK_BROKERED": true,
}

var urlInArgRE = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.-]*://[^\s'"]+`)

func isLocalHost(h string) bool {
	if h == ProbeHost || strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// checkLocalArgv refuses a probe command that names anything but the local stand-in.
func checkLocalArgv(argv []string) error {
	if len(argv) == 0 || argv[0] == "" {
		return errors.New("empty probe command")
	}
	for _, a := range argv {
		for _, m := range urlInArgRE.FindAllString(a, -1) {
			u, err := url.Parse(m)
			if err != nil || u.User != nil || !isLocalHost(u.Hostname()) {
				return errors.New("a probe command may name only the local stand-in")
			}
		}
	}
	return nil
}

// Run implements ClientRunner.
func (r *ExecRunner) Run(ctx context.Context, harness string) (string, bool, error) {
	argv, ok := r.Probes[harness]
	if !ok {
		return "", false, nil
	}
	if err := checkLocalArgv(argv); err != nil {
		return "", true, err
	}
	if r.Env == nil {
		return "", true, errors.New("no station environment")
	}
	st, err := r.Env(ctx)
	if err != nil {
		return "", true, errors.New("the station environment is unavailable")
	}
	if len(st) == 0 {
		return "", true, errors.New("the station has no broker environment")
	}
	tmp := os.TempDir()
	env := []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + tmp, "TMPDIR=" + tmp, "LANG=C"}
	for k, v := range st {
		if !probeEnvAllowed[k] {
			continue
		}
		if lk := strings.ToLower(k); lk == "https_proxy" || lk == "http_proxy" {
			u, err := url.Parse(v)
			if err != nil || !isLocalHost(u.Hostname()) {
				return "", true, errors.New("the station's proxy is not a local address")
			}
		}
		env = append(env, k+"="+v)
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = harnessProbeTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	exe := r.Exec
	if exe == nil {
		exe = runProbeProcess
	}
	out, err := exe(cctx, argv, env)
	if cctx.Err() != nil {
		return "", true, errors.New("the probe timed out")
	}
	line, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	line = strings.TrimSpace(line)
	if err != nil && (line == "" || line == OutcomeHonoured) {
		// a failing command is not evidence of anything; "honoured" with a failure exit is
		// contradictory and not believed
		return "", true, errors.New("the probe command failed")
	}
	return line, true, nil
}

func runProbeProcess(ctx context.Context, argv, env []string) (string, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = env
	cmd.WaitDelay = time.Second
	var buf limitedBuf
	cmd.Stdout = &buf
	err := cmd.Run()
	return buf.String(), err
}

type limitedBuf struct{ b []byte }

func (l *limitedBuf) Write(p []byte) (int, error) {
	if room := 4096 - len(l.b); room > 0 {
		if len(p) > room {
			l.b = append(l.b, p[:room]...)
		} else {
			l.b = append(l.b, p...)
		}
	}
	return len(p), nil
}

func (l *limitedBuf) String() string { return string(l.b) }

// ---- per station ----

// harnessOf is the harness a station key ("hermes:press") names.
func harnessOf(key string) string {
	h, _, _ := strings.Cut(strings.ToLower(strings.TrimSpace(key)), ":")
	if !clientNameRE.MatchString(h) {
		return ""
	}
	return h
}

func (m *StationInstances) blockedBy(station, source string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.blocked[station][source]
}

// coverage is what the node did to route the station's harness through the station's broker, read
// from its own records. A path it has no record of wiring is NOT wired: the node never claims
// brokered coverage it did not set up.
func (m *StationInstances) coverage(station string) (harness string, paths []BypassPath, blocked string) {
	key := m.keyOf(station)
	harness = harnessOf(key)
	h := m.cfg.Harness
	spawn := BypassPath{Path: "spawn"}
	switch {
	case h == nil:
		spawn.Reason = "harness wiring is not enabled on this node"
	case key == "":
		spawn.Reason = "the node holds no harness key for this station"
	case m.blockedBy(station, "spawn") != "":
		spawn.Reason = m.blockedBy(station, "spawn")
	default:
		spawn.Wired = true
	}
	paths = append(paths, spawn)
	// A long-lived gateway is a second path with its own environment: wired only through a unit
	// that belongs to this station alone. A gateway that serves several stations (OpenClaw's, a
	// Hermes root gateway) has no such unit and is not routed.
	if harness == "hermes" || harness == "openclaw" {
		gw := BypassPath{Path: "gateway"}
		var units []string
		if h != nil {
			units = h.units(key)
		}
		switch {
		case len(units) == 0:
			gw.Reason = "no unit of this station's own starts the gateway; a gateway that serves several stations is not routed through a station's broker"
		case m.blockedBy(station, "unit") != "":
			gw.Reason = m.blockedBy(station, "unit")
		default:
			gw.Wired, gw.Units = true, units
		}
		paths = append(paths, gw)
	}
	return harness, paths, m.WiringBlocked(station)
}

func anyWired(paths []BypassPath) bool {
	for _, p := range paths {
		if p.Wired {
			return true
		}
	}
	return false
}

// bypassHook is the Service.Bypass of the station's instance: stk's probe through the station's
// own client, and the harness's own client only when a path of it is wired.
func (m *StationInstances) bypassHook(station string, stGet func() *stationState) func(context.Context, stkclient.Client) []ClientOutcome {
	return func(ctx context.Context, c stkclient.Client) []ClientOutcome {
		if m.cfg.Bypass != nil {
			return m.cfg.Bypass(ctx, c)
		}
		harness, paths, _ := m.coverage(station)
		var run ClientRunner
		if anyWired(paths) && len(m.cfg.HarnessProbes) > 0 {
			r := &ExecRunner{Probes: m.cfg.HarnessProbes, Exec: m.cfg.ProbeExec,
				Env: func(ctx context.Context) (map[string]string, error) {
					st := stGet()
					if st == nil {
						return nil, errors.New("no instance")
					}
					env, _, err := m.stationEnv(ctx, st)
					return env, err
				}}
			run = r.Run
		}
		return CheckBypass(ctx, c, harness, run)
	}
}
