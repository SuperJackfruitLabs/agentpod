package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The seven verbs this binary exists for. Adding one here without adding it to
// fleet.go's switch fails; shipping one in fleet.go without listing it in help
// fails in TestHelpListsEveryVerb below.
var wantVerbs = []string{"login", "whoami", "logout", "nodes", "agents", "stats", "activity"}

func TestDispatchesEveryFleetVerb(t *testing.T) {
	src, err := os.ReadFile("fleet.go")
	if err != nil {
		t.Fatalf("read fleet.go: %v", err)
	}
	got := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\tcase "([a-z]+)":`).FindAllStringSubmatch(string(src), -1) {
		got[m[1]] = true
	}
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
	listed := map[string]bool{}
	for _, line := range strings.Split(help, "\n") {
		if m := regexp.MustCompile(`^  fleet ([a-z]+)`).FindStringSubmatch(line); m != nil {
			listed[m[1]] = true
		}
	}
	for _, v := range wantVerbs {
		if !listed[v] {
			t.Errorf("verb %q is not listed in help", v)
		}
	}
}
