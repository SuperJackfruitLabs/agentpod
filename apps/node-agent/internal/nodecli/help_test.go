package nodecli

import (
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
	text := HelpText("v0.1.13")
	for _, c := range Commands {
		if !strings.Contains(text, c.Name) {
			t.Errorf("helpText missing command %q, got:\n%s", c.Name, text)
		}
	}
}

func TestHelpTextContainsGroupsExamplesAndVersion(t *testing.T) {
	text := HelpText("v0.1.13")
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
		if got := SuggestCommand("statsu"); got != "status" {
			t.Errorf("suggestCommand(%q) = %q, want %q", "statsu", got, "status")
		}
	})

	t.Run("no_close_match_returns_empty", func(t *testing.T) {
		if got := SuggestCommand("zzz"); got != "" {
			t.Errorf("suggestCommand(%q) = %q, want empty", "zzz", got)
		}
	})
}

// ---------------------------------------------------------------------------
// per-command help
// ---------------------------------------------------------------------------

func TestCommandHelpStopMentionsStickySemantics(t *testing.T) {
	text := CommandHelp("stop")
	if !strings.Contains(text, "sticky") || !strings.Contains(text, "disable") {
		t.Errorf("commandHelp(stop) missing sticky/disable semantics, got:\n%s", text)
	}
}

func TestCommandHelpLogsMentionsPlatformSources(t *testing.T) {
	text := CommandHelp("logs")
	if !strings.Contains(text, "Library/Logs") {
		t.Errorf("commandHelp(logs) missing macOS log source, got:\n%s", text)
	}
	if !strings.Contains(text, "journalctl") {
		t.Errorf("commandHelp(logs) missing linux log source, got:\n%s", text)
	}
}

func TestCommandHelpUnknownReturnsEmpty(t *testing.T) {
	if got := CommandHelp("bogus"); got != "" {
		t.Errorf("commandHelp(bogus) = %q, want empty", got)
	}
}
