package forgeapi

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// MinStkVersion is the oldest stk this node will broker through.
const MinStkVersion = "0.0.1"

// DefaultProbeTimeout bounds one capability probe. The probe sits on the connect path.
const DefaultProbeTimeout = 5 * time.Second

// CompareVersions orders two `major.minor.patch` versions: -1, 0 or 1. A leading v/V is accepted
// and so is a pre-release or build suffix (`-rc.1`, `+sha`), which is IGNORED: the numeric core
// decides, so a pre-release of the floor counts as the floor. Anything else is an error.
func CompareVersions(a, b string) (int, error) {
	pa, err := parseVersion(a)
	if err != nil {
		return 0, err
	}
	pb, err := parseVersion(b)
	if err != nil {
		return 0, err
	}
	for i := range pa {
		switch {
		case pa[i] < pb[i]:
			return -1, nil
		case pa[i] > pb[i]:
			return 1, nil
		}
	}
	return 0, nil
}

func parseVersion(v string) ([3]uint32, error) {
	var out [3]uint32
	s := strings.TrimSpace(v)
	s = strings.TrimPrefix(strings.TrimPrefix(s, "v"), "V")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return out, errors.New("not a major.minor.patch version")
	}
	for i, p := range parts {
		if p == "" {
			return out, errors.New("not a major.minor.patch version")
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return out, errors.New("not a major.minor.patch version")
			}
		}
		n, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			return out, errors.New("not a major.minor.patch version")
		}
		out[i] = uint32(n)
	}
	return out, nil
}

// checkStkVersion maps a version string to the errors the verbs already turn into reason codes:
// below the floor is ErrStkTooOld, unreadable is ErrStkNotRunnable. The error never quotes the
// version text.
func checkStkVersion(v string) error {
	c, err := CompareVersions(v, MinStkVersion)
	if err != nil {
		return fmt.Errorf("stk version is unreadable: %w", stkclient.ErrStkNotRunnable)
	}
	if c < 0 {
		return fmt.Errorf("stk is older than %s: %w", MinStkVersion, stkclient.ErrStkTooOld)
	}
	return nil
}

// Availability is one probe's verdict. Reason is a stable code (`stk-missing`, `stk-too-old`,
// `stk-not-runnable`) and is empty when Available.
type Availability struct {
	Available bool
	Reason    string
	Version   string
}

// reasonOf maps a probe error to a reason code without ever quoting it.
func reasonOf(err error) string {
	switch {
	case errors.Is(err, stkclient.ErrStkMissing):
		return "stk-missing"
	case errors.Is(err, stkclient.ErrStkTooOld):
		return "stk-too-old"
	}
	return "stk-not-runnable"
}

// CapabilityProbe decides whether the node may advertise `forge.api`: stk answers `version` with
// at least MinStkVersion, and `doctor --json` parses and names an isolation level. It never
// installs anything. Refresh runs on every (re)connect; Available is a cheap read of the last
// answer for the detect path.
type CapabilityProbe struct {
	newClient func() stkclient.Client
	timeout   time.Duration

	mu      sync.Mutex
	last    Availability
	logged  bool
	lastLog Availability
}

// NewCapabilityProbe takes the client factory (a client built for the machine as it is now, so a
// service user created since the last probe is noticed) and a deadline; zero means the default.
func NewCapabilityProbe(newClient func() stkclient.Client, timeout time.Duration) *CapabilityProbe {
	if timeout <= 0 {
		timeout = DefaultProbeTimeout
	}
	return &CapabilityProbe{newClient: newClient, timeout: timeout}
}

// Available is the last Refresh's verdict; false until the first Refresh. It runs nothing.
func (p *CapabilityProbe) Available() bool { return p.Last().Available }

// Last returns the last verdict.
func (p *CapabilityProbe) Last() Availability {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.last
}

// Refresh probes stk afresh, stores and returns the verdict. It returns within the probe timeout
// even if the client ignores its context: the check runs in its own goroutine and is abandoned
// (its context cancelled) at the deadline. An outcome is logged only when it changes, and only as
// the reason code and the stk version.
func (p *CapabilityProbe) Refresh(ctx context.Context) Availability {
	pctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	done := make(chan Availability, 1)
	go func() { done <- p.check(pctx) }()

	var a Availability
	timedOut := false
	select {
	case a = <-done:
	case <-pctx.Done():
		a = Availability{Reason: "stk-not-runnable"}
		timedOut = errors.Is(pctx.Err(), context.DeadlineExceeded)
	}
	p.mu.Lock()
	p.last = a
	changed := !p.logged || p.lastLog != a
	p.logged, p.lastLog = true, a
	p.mu.Unlock()
	if changed {
		switch {
		case a.Available:
			logf("forgeapi: forge.api available (stk %s)", a.Version)
		case timedOut:
			logf("forgeapi: forge.api unavailable: %s (probe timed out after %s)", a.Reason, p.timeout)
		default:
			logf("forgeapi: forge.api unavailable: %s", a.Reason)
		}
	}
	return a
}

func (p *CapabilityProbe) check(ctx context.Context) Availability {
	c := p.newClient()
	v, err := c.Version(ctx)
	if err != nil {
		return Availability{Reason: reasonOf(err)}
	}
	if err := checkStkVersion(v); err != nil {
		return Availability{Reason: reasonOf(err)}
	}
	v = strings.TrimSpace(v)
	// Doctor must parse and name an isolation level; same-user is allowed (the ack labels it), but
	// a doctor that cannot say at all is not a usable broker.
	rep, err := c.Doctor(ctx)
	if err != nil || rep.Isolation.Level == "" {
		return Availability{Reason: "stk-not-runnable", Version: v}
	}
	return Availability{Available: true, Version: v}
}
