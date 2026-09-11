package main

import (
	"bytes"
	"os"
	"regexp"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// top-level help
// ---------------------------------------------------------------------------

// TestHelpTextContainsEveryRegisteredCommand iterates the commands registry
// itself (rather than a hard-coded list) so a new command that forgets to
// add a one-liner fails this test.
func TestHelpTextContainsEveryRegisteredCommand(t *testing.T) {
	text := helpText("v0.1.13")
	for _, c := range commands {
		if !strings.Contains(text, c.name) {
			t.Errorf("helpText missing command %q, got:\n%s", c.name, text)
		}
	}
}

func TestHelpTextContainsGroupsExamplesAndVersion(t *testing.T) {
	text := helpText("v0.1.13")
	for _, want := range []string{
		"Service:",
		"Node:",
		"Maintenance:",
		"Examples:",
		"apn status",
		"apn logs -f",
		"apn enroll --hub https://hub.example.com --token <TOKEN>",
		"v0.1.13",
		"Usage: apn <command> [flags]",
		"Run 'apn help <command>'",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("helpText missing %q, got:\n%s", want, text)
		}
	}
}

// ---------------------------------------------------------------------------
// did-you-mean
// ---------------------------------------------------------------------------

func TestSuggestCommand(t *testing.T) {
	t.Run("close_typo_matches", func(t *testing.T) {
		if got := suggestCommand("statsu"); got != "status" {
			t.Errorf("suggestCommand(%q) = %q, want %q", "statsu", got, "status")
		}
	})

	t.Run("no_close_match_returns_empty", func(t *testing.T) {
		if got := suggestCommand("zzz"); got != "" {
			t.Errorf("suggestCommand(%q) = %q, want empty", "zzz", got)
		}
	})
}

// ---------------------------------------------------------------------------
// per-command help
// ---------------------------------------------------------------------------

func TestCommandHelpStopMentionsStickySemantics(t *testing.T) {
	text := commandHelp("stop")
	if !strings.Contains(text, "sticky") || !strings.Contains(text, "disable") {
		t.Errorf("commandHelp(stop) missing sticky/disable semantics, got:\n%s", text)
	}
}

func TestCommandHelpLogsMentionsPlatformSources(t *testing.T) {
	text := commandHelp("logs")
	if !strings.Contains(text, "Library/Logs") {
		t.Errorf("commandHelp(logs) missing macOS log source, got:\n%s", text)
	}
	if !strings.Contains(text, "journalctl") {
		t.Errorf("commandHelp(logs) missing linux log source, got:\n%s", text)
	}
}

func TestCommandHelpUnknownReturnsEmpty(t *testing.T) {
	if got := commandHelp("bogus"); got != "" {
		t.Errorf("commandHelp(bogus) = %q, want empty", got)
	}
}

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
	for _, c := range commands {
		t.Run(c.name, func(t *testing.T) {
			var buf bytes.Buffer
			if !maybeShowHelp(&buf, c.name, []string{"-h"}) {
				t.Fatalf("maybeShowHelp(%q, [-h]) = false, want true", c.name)
			}
			if !strings.Contains(buf.String(), commandHelp(c.name)) {
				t.Errorf("maybeShowHelp(%q) output missing its command help, got:\n%s", c.name, buf.String())
			}
		})

		t.Run(c.name+"_double_dash_help", func(t *testing.T) {
			var buf bytes.Buffer
			if !maybeShowHelp(&buf, c.name, []string{"--help"}) {
				t.Fatalf("maybeShowHelp(%q, [--help]) = false, want true", c.name)
			}
		})

		t.Run(c.name+"_no_help_flag_does_not_intercept", func(t *testing.T) {
			var buf bytes.Buffer
			if maybeShowHelp(&buf, c.name, []string{"--json"}) {
				t.Errorf("maybeShowHelp(%q, [--json]) = true, want false — must not swallow real flags", c.name)
			}
			if buf.Len() != 0 {
				t.Errorf("maybeShowHelp(%q, [--json]) wrote output, want none:\n%s", c.name, buf.String())
			}
		})
	}
}

// TestFleetHelpListsEveryVerb guards the gap that shipped: `login` was
// implemented and dispatched in fleet.go, but `apn fleet` help listed six
// verbs and not that one — so the single command a new operator needs first
// was the one command help would not tell them about.
//
// The verbs are read out of fleet.go's own switch rather than restated here,
// because a list maintained by hand beside the list it mirrors is the thing
// that drifted in the first place.
func TestFleetHelpListsEveryVerb(t *testing.T) {
	src, err := os.ReadFile("fleet.go")
	if err != nil {
		t.Fatalf("read fleet.go: %v", err)
	}

	verbs := regexp.MustCompile(`(?m)^\tcase "([a-z]+)":`).FindAllStringSubmatch(string(src), -1)
	if len(verbs) < 5 {
		t.Fatalf("found only %d fleet verbs in fleet.go — the pattern stopped matching", len(verbs))
	}

	// Matched against the VERB LIST, not the whole help text. The detail block
	// also mentions verbs in prose ("the file `apn fleet login` writes"), and a
	// plain substring check is satisfied by that sentence — which is exactly how
	// a missing verb passed an earlier version of this test.
	listed := map[string]bool{}
	for _, line := range strings.Split(commandHelp("fleet"), "\n") {
		if m := regexp.MustCompile(`^  apn fleet ([a-z]+)`).FindStringSubmatch(line); m != nil {
			listed[m[1]] = true
		}
	}

	for _, v := range verbs {
		if !listed[v[1]] {
			t.Errorf("fleet verb %q is dispatched in fleet.go but not listed in `apn fleet` help", v[1])
		}
	}
}
