package contractfix

import (
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gitops"
)

// The changeset fixture exercises every nullable and both sides at once: a
// detached-head-capable branch field, a rename carrying its old path, an
// untracked file with no line counts, and a binary file with none either.
//
// Those nulls are the point. A Go `int` would decode null to 0 and re-marshal
// as 0, silently turning "we did not count this" into "zero lines changed" —
// which reads as "nothing here" for exactly the files an agent just created.
func TestChangesetStatusRoundTrips(t *testing.T) {
	roundTrip(t, "changeset_status.json", &gitops.Status{})
}
