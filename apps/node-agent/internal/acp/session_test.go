package acp

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSession_EchoRoundTrip(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	s, err := m.Open("k", "", []string{"/bin/cat"}, t.TempDir(), nil)
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
	s, _ := m.Open("k", "", []string{"/bin/sh", "-c", "echo err >&2; exit 3"}, t.TempDir(), nil)
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
	s, err := m.Open("k", "", []string{"/bin/sh", "-c", "exit 0"}, t.TempDir(), nil)
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
	s, err := m.Open("k", "", []string{"/bin/cat"}, t.TempDir(), nil)
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

// TestSession_UnsubscribeWaitsForBacklog pins the drain guarantee consumers
// (gateway acp.attach) rely on for exit ordering: unsub must not return until
// every chunk already queued for this subscriber has been delivered to fn —
// otherwise the child's final output (e.g. its last JSON-RPC response) is
// silently truncated when an exit event is emitted right after unsub.
func TestSession_UnsubscribeWaitsForBacklog(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	// Child paces its writes so the fast read loop queues ~20 distinct chunks,
	// then exits immediately after the burst.
	s, err := m.Open("k", "", []string{"/bin/sh", "-c", "i=1; while [ $i -le 20 ]; do echo line$i; sleep 0.01; i=$((i+1)); done"},
		t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var got []byte
	unsub := s.Subscribe(func(c []byte) {
		time.Sleep(30 * time.Millisecond) // slow consumer: backlog builds
		mu.Lock()
		got = append(got, c...)
		mu.Unlock()
	})

	exited := make(chan struct{})
	s.OnExit(func(string) { close(exited) })
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("child did not exit")
	}

	// At child exit the slow subscriber is still draining its queue. unsub
	// must block until that backlog has been delivered.
	unsub()

	mu.Lock()
	defer mu.Unlock()
	for i := 1; i <= 20; i++ {
		if !strings.Contains(string(got), fmt.Sprintf("line%d", i)) {
			t.Fatalf("line%d missing after unsub returned; got %d bytes: %q", i, len(got), got)
		}
	}
}

// TestSession_OnExitUnregister pins that OnExit returns an unregister func so
// long-lived sessions don't accumulate one dead closure per attach/detach
// cycle, and that unregistered callbacks never fire.
func TestSession_OnExitUnregister(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	s, err := m.Open("k", "", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}

	base := s.OnExitCount() // manager registers its own removal hook

	fired := make(chan int, 4)
	unreg1 := s.OnExit(func(string) { fired <- 1 })
	unreg2 := s.OnExit(func(string) { fired <- 2 })
	if got := s.OnExitCount(); got != base+2 {
		t.Fatalf("OnExitCount = %d, want %d", got, base+2)
	}

	unreg1()
	unreg1() // idempotent
	if got := s.OnExitCount(); got != base+1 {
		t.Fatalf("OnExitCount after unregister = %d, want %d", got, base+1)
	}

	if err := m.Close(s.ID()); err != nil {
		t.Fatal(err)
	}

	select {
	case n := <-fired:
		if n != 2 {
			t.Fatalf("unregistered callback %d fired", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("remaining callback did not fire")
	}
	select {
	case n := <-fired:
		t.Fatalf("unexpected extra callback: %d", n)
	case <-time.After(200 * time.Millisecond):
	}

	unreg2() // after exit: must be a harmless no-op
}

func TestManager_OpenEmptyArgv(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	if _, err := m.Open("k", "", nil, t.TempDir(), nil); err == nil {
		t.Fatal("Open with empty argv should error, not panic")
	}
}

func TestManager_CloseKillsProcess(t *testing.T) {
	m := NewManager()
	s, _ := m.Open("k", "", []string{"/bin/cat"}, t.TempDir(), nil)
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
