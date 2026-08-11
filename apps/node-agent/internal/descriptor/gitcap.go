package descriptor

import (
	"context"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gitops"
)

// changesetProbeTimeout bounds the repo check. Detect runs on every node
// connect and a slow filesystem must not stall enrolment.
const changesetProbeTimeout = 3 * time.Second

// AppendChangesetCap adds "changeset" when the station's workspace is a git
// repository and git is usable.
//
// Advertised conditionally so a station whose workspace is not a repo shows no
// tab, rather than one that always errors.
//
// Returns a NEW slice with its own backing array: descriptors build one caps
// slice and reuse it across several stations, so appending in place would leak
// one station's capability onto its siblings — including stations whose
// workspace is not a repo at all.
func AppendChangesetCap(caps []string, workspacePath *string) []string {
	out := make([]string, len(caps), len(caps)+1)
	copy(out, caps)

	if workspacePath == nil || *workspacePath == "" {
		return out
	}

	ctx, cancel := context.WithTimeout(context.Background(), changesetProbeTimeout)
	defer cancel()

	if gitops.IsRepo(ctx, *workspacePath) {
		out = append(out, "changeset")
	}
	return out
}
