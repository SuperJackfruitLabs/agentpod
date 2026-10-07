package main

import (
	"regexp"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"
)

// staleIssuer matches wording from before the organization plane, when the hub minted the
// tokens a person or an agent presents. Tokens now come from the workspace's account service;
// the hub only verifies them, so "hub token" / "hub-issued" names the wrong issuer.
var staleIssuer = regexp.MustCompile(`(?i)hub-issued|hub tokens?\b|issued by the hub`)

// Every surface an operator reads: the verb list, each verb's detail, and the rendered
// reference page (which carries each flag's usage string from its FlagSet).
func TestHelpNamesNoStaleTokenIssuer(t *testing.T) {
	var all strings.Builder
	all.WriteString(helpText("test"))
	for _, c := range commands {
		all.WriteString(commandHelp(c.name))
		all.WriteString("\n")
	}
	src, err := clidoc.Load(".")
	if err != nil {
		t.Fatal(err)
	}
	page, err := clidoc.Render(apnReference(), src)
	if err != nil {
		t.Fatal(err)
	}
	all.WriteString(page)

	for _, line := range strings.Split(all.String(), "\n") {
		if staleIssuer.MatchString(line) {
			t.Errorf("stale token-issuer wording: %q", strings.TrimSpace(line))
		}
	}
}
