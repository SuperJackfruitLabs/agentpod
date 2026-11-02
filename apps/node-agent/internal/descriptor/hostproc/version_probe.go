package hostproc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// ProbeVersion runs one version query under its own deadline and retries it
// once when, and only when, that deadline expired. The overall bound stays
// finite (at most two deadlines), so a stalled mount still cannot wedge the
// caller; a query that failed for any other reason is not retried, because
// running it again would only repeat the answer.
func ProbeVersion(ctx context.Context, timeout time.Duration, query func(context.Context) (string, error)) descriptor.VersionProbe {
	var last descriptor.VersionProbe
	for attempt := 0; attempt < 2; attempt++ {
		if err := ctx.Err(); err != nil {
			return descriptor.VersionProbe{Status: descriptor.VersionUndetermined, Reason: "The version query was cancelled: " + err.Error()}
		}
		attemptCtx, cancel := context.WithTimeout(ctx, timeout)
		version, err := query(attemptCtx)
		timedOut := errors.Is(attemptCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
		cancel()
		version = strings.TrimSpace(version)
		if err == nil && version != "" {
			return descriptor.VersionProbe{Version: version, Status: descriptor.VersionKnown, Reason: "Read the installed version"}
		}
		if !timedOut {
			reason := "The version query returned no version"
			if err != nil {
				reason = "The version query failed: " + err.Error()
			}
			return descriptor.VersionProbe{Status: descriptor.VersionUndetermined, Reason: reason}
		}
		last = descriptor.VersionProbe{Status: descriptor.VersionUndetermined, TimedOut: true,
			Reason: fmt.Sprintf("The version query did not answer within %s, twice; the version is undetermined, not missing", timeout)}
	}
	return last
}
