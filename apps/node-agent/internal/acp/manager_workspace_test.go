package acp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

func waitSignal(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for process transition")
	}
}

func requireWorkspaceIdle(t *testing.T, g *workspacegate.Coordinator, dir string) {
	t.Helper()
	p, err := g.Exclusive(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	p.Release()
}

func TestWorkspaceReservedBeforeSpawnAndReleasedOnFailure(t *testing.T) {
	g := workspacegate.New()
	m := NewManagerWithWorkspaces(g)
	defer m.Shutdown()
	dir := t.TempDir()
	entered, proceed := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(proceed) }) }
	defer unblock()
	m.spawn = func(string, []string, string, []string) (*Session, error) {
		close(entered)
		<-proceed
		return nil, errors.New("fixture spawn failure")
	}
	result := make(chan error, 1)
	go func() { _, err := m.Open("codex:test", "pending", []string{"fixture"}, dir, nil); result <- err }()
	waitSignal(t, entered)
	if _, err := g.Exclusive(context.Background(), dir); !errors.Is(err, workspacegate.ErrBusy) {
		t.Fatalf("starting process untracked: %v", err)
	}
	unblock()
	if err := <-result; err == nil {
		t.Fatal("missing spawn error")
	}
	requireWorkspaceIdle(t, g, dir)
}

func TestPublicationBlocksSpawnAndPreservesOtherWorkspaces(t *testing.T) {
	g := workspacegate.New()
	m := NewManagerWithWorkspaces(g)
	defer m.Shutdown()
	dir := t.TempDir()
	p, err := g.Exclusive(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Release()
	if _, err := m.Open("codex:test", "blocked", []string{"/bin/cat"}, dir, nil); !errors.Is(err, workspacegate.ErrBusy) {
		t.Fatalf("spawned during publication: %v", err)
	}
	s, err := m.Open("codex:other", "allowed", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Close(s.ID()); err != nil {
		t.Fatal(err)
	}
	p.Release()
	s, err = m.Open("codex:test", "allowed", []string{"/bin/cat"}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Exclusive(context.Background(), dir); !errors.Is(err, workspacegate.ErrBusy) {
		t.Fatal("live process untracked")
	}
	if err := m.Close(s.ID()); err != nil {
		t.Fatal(err)
	}
	requireWorkspaceIdle(t, g, dir)
}

func TestClosingChildRetainsWorkspaceUntilReaped(t *testing.T) {
	g := workspacegate.New()
	m := NewManagerWithWorkspaces(g)
	defer m.Shutdown()
	dir := t.TempDir()
	// The child acknowledges TERM, then stays alive until the test releases it.
	s, err := m.Open("codex:test", "closing", []string{"/bin/sh", "-c", `trap 'echo closing > closing; while [ ! -f release ]; do sleep 0.01; done; exit 0' TERM; echo ready > ready; while :; do sleep 0.01; done`}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	waitFile := func(name string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("child did not write %s", name)
			}
			time.Sleep(time.Millisecond)
		}
	}
	waitFile("ready")
	closed := make(chan struct{})
	go func() { _ = m.Close(s.ID()); close(closed) }()
	waitFile("closing")
	if _, err := g.Exclusive(context.Background(), dir); !errors.Is(err, workspacegate.ErrBusy) {
		t.Fatalf("closing child untracked: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitSignal(t, closed)
	requireWorkspaceIdle(t, g, dir)
}

func TestShutdownWaitsForPendingSpawnAndRefusesNewOpens(t *testing.T) {
	g := workspacegate.New()
	m := NewManagerWithWorkspaces(g)
	dir := t.TempDir()
	entered, proceed := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(proceed) }) }
	defer m.Shutdown()
	defer unblock()
	m.spawn = func(id string, argv []string, dir string, env []string) (*Session, error) {
		close(entered)
		<-proceed
		return newSession(id, argv, dir, env)
	}
	result := make(chan error, 1)
	go func() { _, err := m.Open("codex:test", "pending", []string{"/bin/cat"}, dir, nil); result <- err }()
	waitSignal(t, entered)
	stopped := make(chan struct{})
	go func() { m.Shutdown(); close(stopped) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		m.mu.Lock()
		closed := m.closed
		m.mu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("shutdown did not close admission")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-stopped:
		t.Fatal("shutdown returned with pending spawn")
	default:
	}
	if _, err := m.Open("codex:test", "new", []string{"/bin/cat"}, dir, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("open during shutdown: %v", err)
	}
	unblock()
	if err := <-result; !errors.Is(err, ErrClosed) {
		t.Fatalf("pending open escaped shutdown: %v", err)
	}
	waitSignal(t, stopped)
	requireWorkspaceIdle(t, g, dir)
}

func TestConcurrentOpenSpawnsOneChildAndRetainsOneReservation(t *testing.T) {
	g := workspacegate.New()
	m := NewManagerWithWorkspaces(g)
	defer m.Shutdown()
	dir := t.TempDir()
	var spawns atomic.Int32
	m.spawn = func(id string, argv []string, dir string, env []string) (*Session, error) {
		spawns.Add(1)
		return newSession(id, argv, dir, env)
	}
	var wg sync.WaitGroup
	sessions := make([]*Session, 12)
	for i := range sessions {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var err error
			sessions[i], err = m.Open("codex:test", "same", []string{"/bin/cat"}, dir, nil)
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if spawns.Load() != 1 {
		t.Fatalf("duplicate children spawned: %d", spawns.Load())
	}
	for _, s := range sessions {
		if s == nil || s != sessions[0] {
			t.Fatal("concurrent callers did not share session")
		}
	}
	if err := m.Close(sessions[0].ID()); err != nil {
		t.Fatal(err)
	}
	requireWorkspaceIdle(t, g, dir)
}

func TestBlockedExitCallbackCannotPinWorkspaceReservation(t *testing.T) {
	g := workspacegate.New()
	m := NewManagerWithWorkspaces(g)
	defer m.Shutdown()
	dir := t.TempDir()
	s, err := m.Open("codex:test", "callback", []string{"/bin/cat"}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer func() { close(release); waitSignal(t, returned) }()
	s.OnExit(func(string) { close(entered); <-release; close(returned) })
	s.closeStdin()
	waitSignal(t, entered)
	m.Shutdown()
	requireWorkspaceIdle(t, g, dir)
}
