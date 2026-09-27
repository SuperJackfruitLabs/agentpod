package terminal

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

func await(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("terminal transition timed out")
	}
}

func TestPendingTerminalReservesWorkspaceAndShutdownReapsIt(t *testing.T) {
	g := workspacegate.New()
	m := NewManagerWithWorkspaces(g)
	dir := t.TempDir()
	entered, proceed := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(proceed) }) }
	defer m.Shutdown()
	defer unblock()
	m.spawn = func(id, shell, cwd string, cols, rows uint16) (*Session, error) {
		close(entered)
		<-proceed
		return newSession(id, shell, cwd, cols, rows)
	}
	result := make(chan error, 1)
	go func() { _, err := m.Open("codex:test", "/bin/cat", dir, 80, 24); result <- err }()
	await(t, entered)
	if _, err := g.Exclusive(context.Background(), dir); !errors.Is(err, workspacegate.ErrBusy) {
		t.Fatalf("terminal start untracked: %v", err)
	}
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
			t.Fatal("shutdown admission stayed open")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-stopped:
		t.Fatal("shutdown ignored pending start")
	default:
	}
	unblock()
	if err := <-result; !errors.Is(err, ErrClosed) {
		t.Fatalf("pending start escaped shutdown: %v", err)
	}
	await(t, stopped)
	if _, err := m.Open("codex:test", "/bin/cat", dir, 80, 24); !errors.Is(err, ErrClosed) {
		t.Fatal(err)
	}
	p, err := g.Exclusive(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	p.Release()
}

func TestTerminalNaturalExitReapsAndReleasesWorkspace(t *testing.T) {
	g := workspacegate.New()
	m := NewManagerWithWorkspaces(g)
	defer m.Shutdown()
	dir := t.TempDir()
	s, err := m.Open("codex:test", "/bin/sh", dir, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Write([]byte("exit\n")); err != nil {
		t.Fatal(err)
	}
	await(t, s.done)
	// Close after natural exit must neither call Wait twice nor signal a
	// possibly reused PID. Concurrent repeat closes remain safe.
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := m.Close(s.ID); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	m.Shutdown()
	if s.cmd.ProcessState == nil {
		t.Fatal("child was not reaped")
	}
	p, err := g.Exclusive(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Release()
	if _, err := m.GetByKey("codex:test"); err {
		t.Fatal("dead terminal remains reusable")
	}
	ch, unsub := s.Subscribe()
	defer unsub()
	timer := time.After(time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-timer:
			t.Fatal("late subscriber never saw exit")
		}
	}
}

func TestPublicationBlocksTerminalAndFailedSpawnReleasesLease(t *testing.T) {
	g := workspacegate.New()
	m := NewManagerWithWorkspaces(g)
	defer m.Shutdown()
	dir := t.TempDir()
	p, err := g.Exclusive(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Release()
	if _, err := m.Open("codex:test", "/bin/cat", dir, 80, 24); !errors.Is(err, workspacegate.ErrBusy) {
		t.Fatalf("terminal spawned during publication: %v", err)
	}
	p.Release()
	if _, err := m.Open("codex:test", "/fixture/no-such-executable", dir, 80, 24); err == nil {
		t.Fatal("invalid executable accepted")
	}
	p, err = g.Exclusive(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	p.Release()
}
