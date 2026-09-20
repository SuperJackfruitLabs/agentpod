package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The seven verbs this binary exists for today. This is only a "there are still seven" sanity
// floor, not the source of truth for either side of the comparison below — a list maintained by
// hand beside the list it mirrors is the thing that drifted in the first place (the original
// TestFleetHelpListsEveryVerb this file replaces made exactly that point, and its replacement
// here restated wantVerbs by hand without wiring dispatched ⊆ listed AND listed ⊆ dispatched,
// which is the bug that comment warned about).
var wantVerbs = []string{"login", "whoami", "logout", "nodes", "agents", "stats", "activity", "devices"}

// dispatchedVerbs reads fleet.go's switch directly: the verbs this binary actually dispatches.
func dispatchedVerbs(t *testing.T) map[string]bool {
	t.Helper()
	src, err := os.ReadFile("fleet.go")
	if err != nil {
		t.Fatalf("read fleet.go: %v", err)
	}
	got := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\tcase "([a-z]+)":`).FindAllStringSubmatch(string(src), -1) {
		got[m[1]] = true
	}
	return got
}

// listedVerbs reads helpText's rendered output: the verbs `fleet help` actually shows.
//
// `help` and `version` are excluded even though they render as `  fleet <word>` lines: they are
// dispatched by main.go's own top-level switch, one level above fleet.go's — real commands, just
// not verbs fleet.go's switch can see, so comparing them here would be comparing two different
// dispatch layers rather than checking fleet.go against its own help entries.
func listedVerbs(t *testing.T) map[string]bool {
	t.Helper()
	help := helpText("test")
	listed := map[string]bool{}
	for _, line := range strings.Split(help, "\n") {
		m := regexp.MustCompile(`^  fleet ([a-z]+)`).FindStringSubmatch(line)
		if m == nil {
			continue
		}
		if v := m[1]; v != "help" && v != "version" {
			listed[v] = true
		}
	}
	return listed
}

func TestDispatchesEveryFleetVerb(t *testing.T) {
	got := dispatchedVerbs(t)
	for _, v := range wantVerbs {
		if !got[v] {
			t.Errorf("fleet verb %q is not dispatched in fleet.go", v)
		}
	}
}

// The split, asserted from the outside: this binary must not carry the verbs
// that act on a host. A worker holds this and cannot become a node.
func TestCarriesNoNodeVerbs(t *testing.T) {
	src, err := os.ReadFile("fleet.go")
	if err != nil {
		t.Fatalf("read fleet.go: %v", err)
	}
	for _, forbidden := range []string{"enroll", "run", "service", "update"} {
		if regexp.MustCompile(`(?m)^\tcase "` + forbidden + `":`).MatchString(string(src)) {
			t.Errorf("node verb %q is dispatched in the fleet binary", forbidden)
		}
	}
}

// Help names this binary, not the one it was extracted from.
func TestHelpListsEveryVerbAndSaysFleet(t *testing.T) {
	help := helpText("test")
	if strings.Contains(help, "apn fleet") {
		t.Error("help still says `apn fleet`; this binary is `fleet`")
	}
	listed := listedVerbs(t)
	for _, v := range wantVerbs {
		if !listed[v] {
			t.Errorf("verb %q is not listed in help", v)
		}
	}
}

// TestFleetHelpListsEveryVerb is the property the split's spec promised would move intact from
// node-agent's original help_test.go: every verb dispatched in fleet.go appears in fleet help —
// checked BOTH directions, so a verb added to the switch and forgotten in help fails here (the
// original bug), and so does a verb listed in help that no case in the switch actually dispatches.
func TestFleetHelpListsEveryVerb(t *testing.T) {
	dispatched := dispatchedVerbs(t)
	listed := listedVerbs(t)
	for v := range dispatched {
		if !listed[v] {
			t.Errorf("fleet.go dispatches %q but fleet help does not list it", v)
		}
	}
	for v := range listed {
		if !dispatched[v] {
			t.Errorf("fleet help lists %q but fleet.go does not dispatch it", v)
		}
	}
}
