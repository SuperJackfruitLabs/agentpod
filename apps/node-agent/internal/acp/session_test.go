package acp

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSession_EchoRoundTrip(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	s, err := m.Open("k", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan []byte, 4)
	unsub := s.Subscribe(func(c []byte) { got <- append([]byte(nil), c...) })
	defer unsub()
	if err := s.Write([]byte("{\"jsonrpc\":\"2.0\"}\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case c := <-got:
		if !strings.Contains(string(c), "jsonrpc") {
			t.Fatalf("chunk = %q", c)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no echo received")
	}
}

func TestSession_ExitFiresOnceWithReason(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	s, _ := m.Open("k", []string{"/bin/sh", "-c", "echo err >&2; exit 3"}, t.TempDir(), nil)
	reasons := make(chan string, 2)
	s.OnExit(func(r string) { reasons <- r })
	select {
	case r := <-reasons:
		if !strings.Contains(r, "exit status 3") || !strings.Contains(r, "err") {
			t.Fatalf("reason = %q", r)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no exit callback")
	}
	select {
	case r := <-reasons:
		t.Fatalf("second callback: %q", r)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestSession_CloseFromOnExitDoesNotDeadlock(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	s, err := m.Open("k", []string{"/bin/sh", "-c", "exit 0"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	s.OnExit(func(string) {
		_ = s.Close() // must not deadlock on the session's own exit path
		close(done)
	})
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Close called from OnExit deadlocked")
	}
}

func TestManager_CloseWithBlockedSubscriber(t *testing.T) {
	m := NewManager()
	s, err := m.Open("k", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	defer close(release) // let the blocked dispatcher goroutine exit at test end
	first := make(chan struct{})
	var once sync.Once
	s.Subscribe(func([]byte) {
		once.Do(func() { close(first) })
		<-release
	})
	// Prime one chunk and wait until the callback is provably blocked in it.
	if err := s.Write([]byte("prime\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-first:
	case <-time.After(3 * time.Second):
		t.Fatal("no first chunk delivered")
	}
	// Push chunks past the per-subscriber buffer while the callback is
	// blocked; the read loop must never wedge on a stalled consumer.
	for i := 0; i < subChanBuffer+8; i++ {
		if err := s.Write([]byte("chunk\n")); err != nil {
			t.Fatal(err)
		}
	}
	exited := make(chan string, 1)
	s.OnExit(func(r string) { exited <- r })
	closed := make(chan error, 1)
	go func() { closed <- m.Close(s.ID()) }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Manager.Close hung with a blocked subscriber")
	}
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("process not reaped")
	}
}

func TestManager_OpenEmptyArgv(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	if _, err := m.Open("k", nil, t.TempDir(), nil); err == nil {
		t.Fatal("Open with empty argv should error, not panic")
	}
}

func TestManager_CloseKillsProcess(t *testing.T) {
	m := NewManager()
	s, _ := m.Open("k", []string{"/bin/cat"}, t.TempDir(), nil)
	done := make(chan string, 1)
	s.OnExit(func(r string) { done <- r })
	if err := m.Close(s.ID()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("process not reaped")
	}
	if _, ok := m.Get(s.ID()); ok {
		t.Fatal("session still registered after Close")
	}
}
