package main

import (
	"flag"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"
)

var update = flag.Bool("update", false, "rewrite the generated reference page")

const referencePage = "../../../../docs-site/src/content/docs/reference/apn.md"

// TestReferencePage is the guard: every command, subverb, flag and environment variable this
// binary has must be in help.go's table and reference.go, and the committed page must be what
// they render. Regenerate the page with:
//
//	go test ./cmd/agentpod-node -run TestReferencePage -update
func TestReferencePage(t *testing.T) {
	src, err := clidoc.Load(".")
	if err != nil {
		t.Fatal(err)
	}
	if err := clidoc.Sync(apnReference(), src, referencePage, *update); err != nil {
		t.Fatal(err)
	}
}

// The guard has to be able to fail: removing an entry the source still dispatches is reported.
func TestReferenceGuardCatchesARemovedEntry(t *testing.T) {
	src, err := clidoc.Load(".")
	if err != nil {
		t.Fatal(err)
	}
	full := apnReference()
	for _, path := range []string{"telemetry enable", "native-skills status", "hermes-live disable", "version", "service install"} {
		b := full
		b.Commands = nil
		for _, c := range full.Commands {
			if c.Path != path {
				b.Commands = append(b.Commands, c)
			}
		}
		if len(clidoc.Check(b, src)) == 0 {
			t.Errorf("removing %q from the reference went unnoticed", path)
		}
	}
}

// A command in the help table with no reference entry cannot render at all.
func TestEveryHelpCommandHasAReferenceEntry(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatal(r)
		}
	}()
	apnReference()
}
