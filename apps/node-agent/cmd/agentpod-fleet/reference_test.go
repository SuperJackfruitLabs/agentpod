package main

import (
	"flag"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"
)

var update = flag.Bool("update", false, "rewrite the generated reference page")

const referencePage = "../../../../docs-site/src/content/docs/reference/fleet.md"

// TestReferencePage is the guard: every verb, subverb, flag and environment variable this
// binary has must be in reference.go, and the committed page must be what reference.go renders.
// Regenerate the page with:
//
//	go test ./cmd/agentpod-fleet -run TestReferencePage -update
func TestReferencePage(t *testing.T) {
	src, err := clidoc.Load(".")
	if err != nil {
		t.Fatal(err)
	}
	if err := clidoc.Sync(reference, src, referencePage, *update); err != nil {
		t.Fatal(err)
	}
}

// The guard has to be able to fail. Each case removes one thing the source still has from a
// copy of the real table; each must be reported.
func TestReferenceGuardCatchesARemovedEntry(t *testing.T) {
	src, err := clidoc.Load(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"nodes telemetry", "principals add-service", "settings speech test", "devices revoke", "version"} {
		b := reference
		b.Commands = nil
		for _, c := range reference.Commands {
			if c.Path != path {
				b.Commands = append(b.Commands, c)
			}
		}
		if len(clidoc.Check(b, src)) == 0 {
			t.Errorf("removing %q from the reference went unnoticed", path)
		}
	}
}
