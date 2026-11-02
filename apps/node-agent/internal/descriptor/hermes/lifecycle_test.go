package hermes

import (
	"testing"
)

// --- hermesDescriptor lifecycle ---

func TestHermesLifecycle_StopNoProcess_ReturnsError(t *testing.T) {
	h := &Descriptor{home: t.TempDir()}
	// A PROFILE key, not the root key.
	//
	// The root key's pattern is the bare word "hermes", which `pgrep -f`
	// matches anywhere in a command line -- including the path of a stub
	// binary a sibling test is executing at that moment. This test asserted
	// that no such process exists anywhere on the machine, which is not a
	// property a test can assume: it passed alone and in a clean cache, and
	// failed intermittently under `go test ./...` where sibling descriptor
	// tests run stubs named `hermes`.
	//
	// A profile key yields "(-p|--profile)[ =]<name> gateway", and the name
	// below is unique to this test, so nothing can match it by accident.
	// CLAUDE.md already records this hazard for process stubs; it reaches
	// test assertions too.
	err := h.Stop("hermes:sjl-stop-no-process-fixture")
	if err == nil {
		t.Fatal("expected error when no hermes process is running")
	}
}

func TestHermesLifecycle_StartNoCommand_ReturnsError(t *testing.T) {
	h := &Descriptor{home: t.TempDir()}
	err := h.Start("hermes")
	if err == nil {
		t.Fatal("expected error when startCmd is empty")
	}
}
