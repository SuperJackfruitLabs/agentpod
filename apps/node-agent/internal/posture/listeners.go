package posture

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// CheckListenersID covers the condition behind the strategy's headline: an
// agent runtime listening on every interface rather than loopback is an agent
// anyone who can route to the box can drive.
const CheckListenersID = "listen.public"

// HarnessProcessNames maps a process name, as the OS reports it, to the harness
// it belongs to. lsof truncates COMMAND, so matching is by prefix.
var HarnessProcessNames = map[string]string{
	"hermes":   "hermes",
	"openclaw": "openclaw",
	"opencode": "opencode",
	"codex":    "codex",
	"claude":   "claude-code",
}

// Listener is one parsed listening socket.
type Listener struct {
	Command string
	PID     string
	Addr    string // as lsof prints it: "*:3000", "127.0.0.1:8080", "[::1]:9000"
}

// IsPublic reports whether an address accepts connections from other machines.
//
// lsof writes the wildcard as "*", and both "0.0.0.0" and "[::]" mean the same
// thing. Anything else — a loopback address or a specific interface — is not
// reachable from everywhere and is not flagged here.
func (l Listener) IsPublic() bool {
	host := l.Addr
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	switch host {
	case "*", "0.0.0.0", "[::]", "::":
		return true
	}
	return false
}

// ParseLsof extracts listening sockets from `lsof -nP -iTCP -sTCP:LISTEN`
// output. It is a pure function so the check is testable without opening a
// socket or depending on what happens to be running.
func ParseLsof(out string) []Listener {
	var listeners []Listener
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		// COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME [(LISTEN)]
		if len(fields) < 9 || fields[0] == "COMMAND" {
			continue
		}
		if !strings.Contains(line, "(LISTEN)") {
			continue
		}
		listeners = append(listeners, Listener{
			Command: fields[0],
			PID:     fields[1],
			Addr:    fields[8],
		})
	}
	return listeners
}

// harnessFor returns the harness a process name belongs to, if any.
func harnessFor(command string) (string, bool) {
	c := strings.ToLower(command)
	for prefix, harness := range HarnessProcessNames {
		if strings.HasPrefix(c, prefix) {
			return harness, true
		}
	}
	return "", false
}

// EvaluateListeners turns parsed listeners into findings. Only harness
// processes are considered — this is a check on agent runtimes, not a general
// port audit, and flagging the user's database would be noise.
func EvaluateListeners(listeners []Listener) []Finding {
	var out []Finding
	sawHarness := false

	for _, l := range listeners {
		harness, ok := harnessFor(l.Command)
		if !ok {
			continue
		}
		sawHarness = true

		if l.IsPublic() {
			out = append(out, Finding{
				Check: CheckListenersID, Status: StatusFail, Severity: SeverityCritical,
				Harness: harness,
				Title:   "Agent is listening on every network interface",
				Detail: fmt.Sprintf(
					"%s (pid %s) is bound to %s. Anything that can route to this machine can reach it — "+
						"and if its gateway auth is off, drive it.", l.Command, l.PID, l.Addr),
				Remedy: "Bind the agent to 127.0.0.1 and reach it over SSH or a private network (Tailscale, WireGuard) instead.",
			})
			continue
		}

		out = append(out, Finding{
			Check: CheckListenersID, Status: StatusPass, Severity: SeverityInfo,
			Harness: harness,
			Title:   "Agent listener is not publicly bound",
			Detail:  fmt.Sprintf("%s (pid %s) on %s", l.Command, l.PID, l.Addr),
		})
	}

	if !sawHarness {
		// Worth being precise rather than congratulatory. Harnesses driven over
		// stdio — Codex, Claude Code and OpenCode under ACP — never bind a port,
		// so on a machine running only those this check has nothing to say. It
		// catches server-mode runtimes: an OpenClaw gateway, a Hermes daemon.
		out = append(out, Finding{
			Check: CheckListenersID, Status: StatusPass, Severity: SeverityInfo,
			Title: "No agent is listening on a TCP port",
			Detail: "Nothing to expose. Note that stdio-driven harnesses never bind a port, " +
				"so this check only covers agents run in server mode.",
		})
	}
	return out
}

// CheckListeners runs lsof and evaluates the result.
//
// If lsof is unavailable the check reports StatusUnknown rather than passing.
// A scanner that silently downgrades "I could not look" to "looks fine" is
// worse than one that does not run.
func CheckListeners(ctx context.Context) []Finding {
	path, err := exec.LookPath("lsof")
	if err != nil {
		return []Finding{{
			Check: CheckListenersID, Status: StatusUnknown, Severity: SeverityWarning,
			Title:  "Could not check for exposed listeners",
			Detail: "lsof is not installed, so open ports could not be enumerated.",
			Remedy: "Install lsof and re-run, or check manually: ss -ltnp",
		}}
	}

	out, err := exec.CommandContext(ctx, path, "-nP", "-iTCP", "-sTCP:LISTEN").Output()
	if err != nil && len(out) == 0 {
		return []Finding{{
			Check: CheckListenersID, Status: StatusUnknown, Severity: SeverityWarning,
			Title:  "Could not check for exposed listeners",
			Detail: fmt.Sprintf("lsof failed: %v", err),
			Remedy: "Check manually: ss -ltnp",
		}}
	}
	return EvaluateListeners(ParseLsof(string(out)))
}
