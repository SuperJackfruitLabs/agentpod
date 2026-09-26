// Package pierrors installs the agentpod-errors Pi extension on this host:
// `apn pi-errors`.
//
// pi-acp forwards none of a failed model call over ACP, so Pi's errors never
// reached AgentPod. The extension reports them to this node's turn-error
// intake (internal/turnerror), keyed by the hub session the node sets on every
// adapter it spawns (AGENTPOD_ACP_SESSION).
//
// Installing is one file in Pi's global extensions directory, which Pi
// discovers on its own. There is no configuration to edit and nothing to
// restart: pi-acp starts a fresh Pi for each session, and each one loads what
// is there. The command still shows what it would do and writes nothing
// without --apply, like `apn openclaw-errors` and `apn hermes-live`.
package pierrors

import (
	"bytes"
	_ "embed"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Name is the extension's file name, without extension.
const Name = "agentpod-errors"

//go:embed extension/agentpod-errors.ts
var embedded []byte

//go:embed extension/pi-tested.min
var testedMin string

//go:embed extension/pi-tested.max
var testedMax string

// Embedded is the extension this apn ships.
func Embedded() []byte { return embedded }

// TestedRange is the Pi versions the extension's contract passed on.
func TestedRange() (min, max string) {
	return strings.TrimSpace(testedMin), strings.TrimSpace(testedMax)
}

// Target is where Pi discovers it: a top-level file, because pi-acp's session
// banner lists top-level extension files only, and a reader should be able to
// see the extension is there.
func Target(home string) string {
	return filepath.Join(home, ".pi", "agent", "extensions", Name+".ts")
}

// ─── Version gate ────────────────────────────────────────────────────────────

var semver = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

func parts(v string) ([3]int, bool) {
	m := semver.FindStringSubmatch(v)
	if m == nil {
		return [3]int{}, false
	}
	var p [3]int
	for i := range p {
		p[i], _ = strconv.Atoi(m[i+1])
	}
	return p, true
}

func compare(a, b [3]int) int {
	for i := range a {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// Gate is whether this Pi is one the extension has been proven on.
type Gate struct {
	Allowed bool
	Reason  string
}

// CheckPi decides from a version probe (status known/absent/undetermined).
func CheckPi(status, version, reason string) Gate {
	min, max := TestedRange()
	switch status {
	case "absent":
		return Gate{Reason: "Pi is not installed here: " + reason}
	case "known":
	default:
		return Gate{Reason: "the Pi version could not be read (" + reason + "); install held until it can"}
	}
	v, ok := parts(version)
	if !ok {
		return Gate{Reason: fmt.Sprintf("%q is not a Pi version this apn understands", version)}
	}
	lo, _ := parts(min)
	hi, _ := parts(max)
	if compare(v, lo) < 0 {
		return Gate{Reason: fmt.Sprintf("Pi %s is older than the oldest tested, %s", version, min)}
	}
	if compare(v, hi) > 0 {
		return Gate{Reason: fmt.Sprintf("Pi %s is newer than the newest tested, %s; the nightly contract run says when a newer one is safe", version, max)}
	}
	return Gate{Allowed: true, Reason: fmt.Sprintf("within the tested range %s to %s", min, max)}
}

// ─── Plan and apply ──────────────────────────────────────────────────────────

// Plan is what enable or disable would do: "add", "replace", "remove" or "keep".
type Plan struct {
	Action string
	Target string
}

// PlanEnable plans installing the extension.
func PlanEnable(home string, gate Gate) (Plan, error) {
	if !gate.Allowed {
		return Plan{}, fmt.Errorf("not installing on this Pi: %s", gate.Reason)
	}
	p := Plan{Target: Target(home)}
	switch current, err := os.ReadFile(p.Target); {
	case err != nil:
		p.Action = "add"
	case bytes.Equal(current, embedded):
		p.Action = "keep"
	default:
		p.Action = "replace"
	}
	return p, nil
}

// PlanDisable plans removing it. Only its own file; the directory and any
// other extension stay.
func PlanDisable(home string) Plan {
	p := Plan{Target: Target(home), Action: "keep"}
	if _, err := os.Stat(p.Target); err == nil {
		p.Action = "remove"
	}
	return p
}

// Apply carries out a plan, writing through a temp file so Pi never loads half
// an extension.
func Apply(p Plan) error {
	switch p.Action {
	case "add", "replace":
		if err := os.MkdirAll(filepath.Dir(p.Target), 0o755); err != nil {
			return err
		}
		tmp := p.Target + ".tmp-apn"
		if err := os.WriteFile(tmp, embedded, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, p.Target); err != nil {
			os.Remove(tmp)
			return err
		}
	case "remove":
		return os.Remove(p.Target)
	}
	return nil
}

// ─── Status ──────────────────────────────────────────────────────────────────

// Status is what is on disk, and whether this node would receive reports.
type Status struct {
	Installed       bool
	Current         bool
	IntakeListening bool
	IntakePath      string
}

// Observe reads the installed file and dials this node's intake socket.
func Observe(home string) Status {
	var st Status
	if b, err := os.ReadFile(Target(home)); err == nil {
		st.Installed = true
		st.Current = bytes.Equal(b, embedded)
	}
	st.IntakePath = strings.TrimSpace(os.Getenv("AGENTPOD_TURN_ERROR_SOCKET"))
	if st.IntakePath == "" {
		st.IntakePath = filepath.Join(home, ".agentpod", "turn-errors.sock")
	}
	if c, err := net.DialTimeout("unix", st.IntakePath, 300*time.Millisecond); err == nil {
		c.Close()
		st.IntakeListening = true
	}
	return st
}
