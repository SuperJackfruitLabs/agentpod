package acp

import (
	"strings"
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
