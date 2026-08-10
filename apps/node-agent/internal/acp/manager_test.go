package acp

import (
	"testing"
	"time"
)

// TestManager_OpenDistinctInstancesAreDistinctSessions pins the multi-session
// contract: two hub sessions on the SAME station must each get their own ACP
// child, or they would read each other's JSON-RPC traffic.
func TestManager_OpenDistinctInstancesAreDistinctSessions(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	a, err := m.Open("opencode:test", "tab-1", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.Open("opencode:test", "tab-2", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}

	if a == b {
		t.Fatal("same *Session returned for two different instances")
	}
	if a.ID() == b.ID() {
		t.Fatalf("both instances got session ID %q", a.ID())
	}
	if a.cmd.Process.Pid == b.cmd.Process.Pid {
		t.Fatalf("both instances share process %d", a.cmd.Process.Pid)
	}

	// Both must be independently addressable by ID.
	if got, ok := m.Get(a.ID()); !ok || got != a {
		t.Fatalf("Get(%q) = %v, %v", a.ID(), got, ok)
	}
	if got, ok := m.Get(b.ID()); !ok || got != b {
		t.Fatalf("Get(%q) = %v, %v", b.ID(), got, ok)
	}
}

// TestManager_OpenSameInstanceIsIdempotent pins that a re-open of the same
// (key, instance) pair returns the identical live session rather than spawning
// a second child.
func TestManager_OpenSameInstanceIsIdempotent(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	first, err := m.Open("opencode:test", "tab-1", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.Open("opencode:test", "tab-1", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}

	if first != second {
		t.Fatalf("re-open of the same instance spawned a new session: %q vs %q", first.ID(), second.ID())
	}
}

// TestManager_OpenEmptyInstanceIsIdempotent pins the legacy contract an older
// hub relies on: no instance means "reuse whatever process this key has".
func TestManager_OpenEmptyInstanceIsIdempotent(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	first, err := m.Open("opencode:test", "", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.Open("opencode:test", "", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}

	if first != second {
		t.Fatalf("legacy re-open (empty instance) spawned a new session: %q vs %q", first.ID(), second.ID())
	}

	// The legacy entry must not collide with a named instance either.
	named, err := m.Open("opencode:test", "tab-1", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if named == first {
		t.Fatal("named instance reused the legacy session for the same key")
	}
}

// TestManager_ExitUnregistersOnlyItsInstance is the sibling-isolation
// regression test: when one instance's child exits, only that (key, instance)
// entry is dropped — its sibling on the same key stays registered and a later
// Open for the dead instance spawns a fresh process.
func TestManager_ExitUnregistersOnlyItsInstance(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	dir := t.TempDir()
	survivor, err := m.Open("opencode:test", "keep", []string{"/bin/cat"}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}

	doomed, err := m.Open("opencode:test", "die", []string{"/bin/sh", "-c", "exit 0"}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	doomed.OnExit(func(string) { close(exited) })
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("doomed child did not exit")
	}

	// The manager's own removal hook runs from the same exit fan-out; wait for
	// the ID index to drop it.
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, ok := m.Get(doomed.ID()); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("exited session still registered by ID")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// The sibling must be untouched: still resolvable by ID, and still the
	// session a re-open of its own instance hands back.
	if _, ok := m.Get(survivor.ID()); !ok {
		t.Fatal("sibling session was unregistered when the other instance exited")
	}
	again, err := m.Open("opencode:test", "keep", []string{"/bin/cat"}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if again != survivor {
		t.Fatalf("re-open of the surviving instance spawned a new session: %q vs %q", again.ID(), survivor.ID())
	}

	// The dead instance's key must be free again, so it spawns a fresh child.
	fresh, err := m.Open("opencode:test", "die", []string{"/bin/cat"}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.ID() == doomed.ID() {
		t.Fatal("re-open of the dead instance returned the dead session")
	}
}

// TestManager_OpenInstanceKeysDoNotCollide guards the composite key encoding:
// distinct (key, instance) pairs must never flatten onto the same map entry
// through naive concatenation.
func TestManager_OpenInstanceKeysDoNotCollide(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	dir := t.TempDir()
	a, err := m.Open("a", "bc", []string{"/bin/cat"}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.Open("ab", "c", []string{"/bin/cat"}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal(`("a","bc") and ("ab","c") collapsed onto the same session`)
	}
}
