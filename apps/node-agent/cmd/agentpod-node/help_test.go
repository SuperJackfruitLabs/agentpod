package main

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/nodecli"
)

// ---------------------------------------------------------------------------
// -h/--help interception gate — registry-driven so every command in
// `commands` is provably covered, not just the four with their own
// flag.FlagSet. This is the gate main.go's non-FlagSet cases (stop, start,
// restart, service, run, detect, version) must check BEFORE doing any real
// work, so `apn stop -h` can never actually stop the service, `apn run -h`
// can never connect and block, etc.
// ---------------------------------------------------------------------------

func TestHelpRequested(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{"dash_h_first", []string{"-h"}, true},
		{"dash_dash_help_first", []string{"--help"}, true},
		{"dash_h_with_trailing_args", []string{"-h", "extra"}, true},
		{"no_args", nil, false},
		{"unrelated_flag", []string{"--json"}, false},
		{"help_not_first", []string{"--json", "-h"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := helpRequested(c.args); got != c.want {
				t.Errorf("helpRequested(%v) = %v, want %v", c.args, got, c.want)
			}
		})
	}
}

// TestMaybeShowHelpCoversEveryRegisteredCommand proves, for every command
// registered in `commands`, that maybeShowHelp recognizes -h/--help and
// prints that command's own detail text — and that it does NOT trigger for
// ordinary (non-help) args, so it never swallows a command's real flags.
func TestMaybeShowHelpCoversEveryRegisteredCommand(t *testing.T) {
	for _, c := range nodecli.Commands {
		t.Run(c.Name, func(t *testing.T) {
			var buf bytes.Buffer
			if !maybeShowHelp(&buf, c.Name, []string{"-h"}) {
				t.Fatalf("maybeShowHelp(%q, [-h]) = false, want true", c.Name)
			}
			if !strings.Contains(buf.String(), nodecli.CommandHelp(c.Name)) {
				t.Errorf("maybeShowHelp(%q) output missing its command help, got:\n%s", c.Name, buf.String())
			}
		})

		t.Run(c.Name+"_double_dash_help", func(t *testing.T) {
			var buf bytes.Buffer
			if !maybeShowHelp(&buf, c.Name, []string{"--help"}) {
				t.Fatalf("maybeShowHelp(%q, [--help]) = false, want true", c.Name)
			}
		})

		t.Run(c.Name+"_no_help_flag_does_not_intercept", func(t *testing.T) {
			var buf bytes.Buffer
			if maybeShowHelp(&buf, c.Name, []string{"--json"}) {
				t.Errorf("maybeShowHelp(%q, [--json]) = true, want false — must not swallow real flags", c.Name)
			}
			if buf.Len() != 0 {
				t.Errorf("maybeShowHelp(%q, [--json]) wrote output, want none:\n%s", c.Name, buf.String())
			}
		})
	}
}

// The removal, asserted rather than assumed. `apn fleet` was a one-release
// surface (v0.1.33) and is gone; the fleet verbs live in agentpod-fleet.
func TestApnDoesNotDispatchFleet(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	if strings.Contains(string(src), `case "fleet":`) {
		t.Error("main.go still dispatches `fleet`; it belongs to agentpod-fleet now")
	}
	if nodecli.CommandHelp("fleet") != "" {
		t.Error("`fleet` is still registered in apn's help table")
	}
}
