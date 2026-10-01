package descriptor

import "testing"

// Resolving the ROOT Hermes gateway — the one started with no profile selector.
//
// `hermesPattern("hermes")` returned the bare string "hermes", so `pgrep -f hermes`
// matched anything with the word in its command line and `hermesPID` took the FIRST
// hit. On guild that was a `hermes dashboard` process 34 days old and ~83 MB, so every
// station reported the dashboard's uptime and memory instead of the gateway's.
//
// It mattered little while only the root station used that pattern. After the
// multiplex fix routed all fifteen profiles through the root gateway's metrics, one
// wrong PID became fifteen wrong rows — and they all agreed with each other, which is
// exactly what made it look plausible.
//
// The picker is pure so every shape that actually appears on a host is testable
// without a process table: a dashboard, a profile gateway, a shell that merely
// mentions the pattern, and the gateway itself in both of its launch forms.
func TestPickRootGateway(t *testing.T) {
	const (
		dashboard   = "/usr/local/lib/hermes-agent/venv/bin/python3 /usr/local/bin/hermes dashboard --host 127.0.0.1 --port 9119 --no-open --insecure"
		moduleForm  = "/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main gateway run"
		scriptForm  = "/usr/local/bin/hermes gateway run"
		profileLong = "/usr/local/bin/hermes --profile coder-kai gateway run"
		profileShrt = "/usr/local/bin/hermes -p coder-kai gateway run --replace"
		profileEq   = "/usr/local/bin/hermes --profile=coder-kai gateway run"
		shellWrap   = `bash -c pgrep -af "gateway run" | head -2; echo done`
		updater     = "/bin/sh -c hermes update --backup && hermes gateway run"
	)

	for _, tc := range []struct {
		name  string
		procs []procInfo
		want  int
		found bool
	}{
		{
			// The exact guild situation: the dashboard is listed first and must lose.
			name:  "dashboard first, gateway second",
			procs: []procInfo{{2004703, dashboard}, {3743876, moduleForm}},
			want:  3743876, found: true,
		},
		{
			name:  "console-script launch form",
			procs: []procInfo{{dashboardPID, dashboard}, {999, scriptForm}},
			want:  999, found: true,
		},
		{
			// A profile gateway is NOT the root gateway, in any flag spelling.
			name:  "only profile gateways running",
			procs: []procInfo{{10, profileLong}, {11, profileShrt}, {12, profileEq}},
			found: false,
		},
		{
			name:  "profile gateways alongside the root one",
			procs: []procInfo{{10, profileShrt}, {11, moduleForm}, {12, profileLong}},
			want:  11, found: true,
		},
		{
			// A shell that merely mentions the pattern matches pgrep -f and is not a
			// gateway. This is not hypothetical: an ssh wrapper and an update watcher
			// both matched on the live host.
			name:  "shell wrappers that mention the pattern",
			procs: []procInfo{{20, shellWrap}, {21, updater}},
			found: false,
		},
		{
			name:  "shell noise plus the real gateway",
			procs: []procInfo{{20, shellWrap}, {21, updater}, {22, moduleForm}},
			want:  22, found: true,
		},
		{
			name:  "nothing is running",
			procs: nil,
			found: false,
		},
		{
			// Hermes installed and busy, but no gateway at all: the honest answer is
			// "no root gateway", not "the first hermes-ish process".
			name:  "dashboard only",
			procs: []procInfo{{dashboardPID, dashboard}},
			found: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pid, ok := pickRootGateway(tc.procs)
			if ok != tc.found {
				t.Fatalf("pickRootGateway found = %v, want %v (pid %d)", ok, tc.found, pid)
			}
			if ok && pid != tc.want {
				t.Errorf("picked pid %d, want %d", pid, tc.want)
			}
		})
	}
}

const dashboardPID = 2004703

// TestProfileSelectorSpellings pins the three ways Hermes accepts a profile, because
// missing one would make a profile gateway masquerade as the root gateway — and the
// root station's metrics would then silently describe one arbitrary agent.
func TestProfileSelectorSpellings(t *testing.T) {
	for _, args := range []string{
		"hermes -p coder-kai gateway run",
		"hermes --profile coder-kai gateway run",
		"hermes --profile=coder-kai gateway run",
		"hermes -p=coder-kai gateway run",
	} {
		if !hasProfileSelector(args) {
			t.Errorf("hasProfileSelector(%q) = false; a profile gateway would be read as the root one", args)
		}
	}
	for _, args := range []string{
		"hermes gateway run",
		"/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main gateway run",
	} {
		if hasProfileSelector(args) {
			t.Errorf("hasProfileSelector(%q) = true; the root gateway would never be found", args)
		}
	}
}
