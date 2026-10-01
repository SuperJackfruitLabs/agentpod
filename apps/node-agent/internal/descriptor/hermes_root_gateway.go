package descriptor

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"os/exec"
)

// Resolving the ROOT Hermes gateway: the gateway started with no profile selector,
// which serves the default profile and — when gateway.multiplex_profiles is on —
// every other profile too.
//
// It used to be resolved by `pgrep -f hermes` taking the first hit. That matches any
// process with the word in its command line, and on guild the first hit was a
// `hermes dashboard` 34 days old and ~83 MB, so the root station reported the
// dashboard's uptime and memory. Harmless-looking while one station used it; after
// multiplexed profiles began reporting through the root gateway it became fifteen
// rows that were all wrong and all agreed with each other.
//
// Three kinds of impostor turn up on a real host, and all three match a loose pgrep:
//
//	a dashboard or any other hermes subcommand   — not a gateway at all
//	a PROFILE gateway (`-p <name> gateway run`)  — a gateway, but not this one
//	a shell that merely mentions the pattern     — an ssh wrapper, an update watcher
//
// So candidates are filtered rather than ranked, and the filter is a pure function.

// procInfo is one candidate process: its pid and its full argv as `ps` prints it.
type procInfo struct {
	pid  int
	args string
}

// shells whose presence means "this process is talking ABOUT a gateway, not running one".
var shellNames = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true, "fish": true,
}

// hasProfileSelector reports whether argv selects a named profile, in any spelling
// Hermes accepts. Missing one would let a profile gateway pass as the root gateway,
// and the root station's metrics would then describe one arbitrary agent.
func hasProfileSelector(args string) bool {
	for _, tok := range strings.Fields(args) {
		if tok == "-p" || tok == "--profile" ||
			strings.HasPrefix(tok, "-p=") || strings.HasPrefix(tok, "--profile=") {
			return true
		}
	}
	return false
}

// isShellInvocation reports whether argv is a shell running a command line. Such a
// process matches `pgrep -f` on any pattern its script happens to contain.
func isShellInvocation(args string) bool {
	fields := strings.Fields(args)
	if len(fields) == 0 {
		return false
	}
	return shellNames[filepath.Base(fields[0])]
}

// runsGateway reports whether argv actually invokes the gateway's run verb, as two
// adjacent tokens rather than as a substring — so a path or a message that merely
// contains the words does not qualify.
func runsGateway(args string) bool {
	fields := strings.Fields(args)
	for i := 0; i+1 < len(fields); i++ {
		if fields[i] == "gateway" && fields[i+1] == "run" {
			return true
		}
	}
	return false
}

// pickRootGateway returns the pid of the root gateway among candidates, or false.
//
// Deliberately a filter and not a best-effort guess: when nothing qualifies the answer
// is "no root gateway is running", which is a true and useful thing to report. The
// previous behaviour — fall back to whatever matched first — is what produced a
// confidently wrong number.
func pickRootGateway(candidates []procInfo) (int, bool) {
	for _, c := range candidates {
		if !runsGateway(c.args) || isShellInvocation(c.args) || hasProfileSelector(c.args) {
			continue
		}
		return c.pid, true
	}
	return 0, false
}

// rootGatewayCandidates lists processes that could be the root gateway.
//
// `pgrep -a` would give pid and argv in one call but does not exist on macOS, which
// this agent also runs on, so argv comes from `ps -o args=` per pid — the same
// portable shape gatherPidMetrics already uses.
func rootGatewayCandidates() []procInfo {
	out, err := exec.Command("pgrep", "-f", "gateway run").Output()
	if err != nil {
		return nil
	}
	// Deliberately no "skip my own pid" guard: what disqualifies a process here is its
	// argv, not its identity. A guard like that protects against nothing the argv
	// filters miss — a shell wrapper is already rejected as a shell — and it would
	// reject a legitimate candidate on any host where the pids happened to coincide.
	var candidates []procInfo
	for _, field := range strings.Fields(string(out)) {
		pid, err := strconv.Atoi(field)
		if err != nil {
			continue
		}
		args, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "args=").Output()
		if err != nil {
			continue
		}
		candidates = append(candidates, procInfo{pid: pid, args: strings.TrimSpace(string(args))})
	}
	return candidates
}

// rootGatewayPID resolves the root gateway's pid, or an error when none is running.
func rootGatewayPID() (int, error) {
	if pid, ok := pickRootGateway(rootGatewayCandidates()); ok {
		return pid, nil
	}
	return 0, fmt.Errorf("hermes: no root gateway process (none running without a profile selector)")
}
