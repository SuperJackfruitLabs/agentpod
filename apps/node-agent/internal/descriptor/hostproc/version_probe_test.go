package hostproc

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// A version probe has three honest outcomes. A probe that ran out of time must
// never be reported as a missing harness or as a version out of range.
func TestProbeVersionSeparatesTheThreeOutcomes(t *testing.T) {
	known := ProbeVersion(context.Background(), time.Second, func(ctx context.Context) (string, error) { return "0.21.3", nil })
	if known.Status != descriptor.VersionKnown || known.Version != "0.21.3" {
		t.Fatalf("known: %+v", known)
	}
	failed := ProbeVersion(context.Background(), time.Second, func(ctx context.Context) (string, error) { return "", errors.New("exit status 1") })
	if failed.Status != descriptor.VersionUndetermined || failed.Version != "" || failed.Reason == "" {
		t.Fatalf("failed: %+v", failed)
	}
	slow := ProbeVersion(context.Background(), 20*time.Millisecond, func(ctx context.Context) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	})
	if slow.Status != descriptor.VersionUndetermined || !slow.TimedOut || slow.Version != "" {
		t.Fatalf("slow: %+v", slow)
	}
}

// A timed-out probe is retried exactly once; any other failure is not.
func TestProbeVersionRetriesATimeoutOnce(t *testing.T) {
	calls := 0
	got := ProbeVersion(context.Background(), 20*time.Millisecond, func(ctx context.Context) (string, error) {
		calls++
		if calls == 1 {
			<-ctx.Done()
			return "", ctx.Err()
		}
		return "0.21.5", nil
	})
	if got.Status != descriptor.VersionKnown || got.Version != "0.21.5" || calls != 2 {
		t.Fatalf("got %+v after %d calls", got, calls)
	}
	calls = 0
	ProbeVersion(context.Background(), 20*time.Millisecond, func(ctx context.Context) (string, error) {
		calls++
		return "", errors.New("not a hermes")
	})
	if calls != 1 {
		t.Fatalf("a non-timeout failure was retried: %d calls", calls)
	}
}
