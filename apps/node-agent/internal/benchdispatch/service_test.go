package benchdispatch

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func TestLostActualUnixServiceReplyNeverResubmits(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	dir, e := os.MkdirTemp("/tmp", "bench-dispatch-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "bench.sock")
	var lc net.ListenConfig
	listener, e := lc.Listen(context.Background(), "unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	var calls atomic.Int32
	received := make(chan string, 1)
	server := http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, err := io.ReadAll(io.LimitReader(r.Body, superbench.MaxBody+1))
		if err != nil {
			t.Error(err)
		}
		received <- digest(body)
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Error("missing hijacker")
			return
		}
		conn, _, err := hijacker.Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = conn.Close()
	})}
	done := make(chan struct{})
	go func() { defer close(done); _ = server.Serve(listener) }()
	defer func() { _ = server.Close(); <-done }()
	client, e := superbench.NewClient(socket, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	request, e := superbench.Parse(raw)
	if e != nil {
		t.Fatal(e)
	}
	launch := func(ctx context.Context) error { _, err := client.Do(ctx, request); return err }
	if e = s.Dispatch(context.Background(), p, raw, allow, launch); !errors.Is(e, ErrPending) {
		t.Fatal(e)
	}
	select {
	case hash := <-received:
		if hash != p.RequestSHA256 {
			t.Fatal("service request changed")
		}
	case <-time.After(time.Second):
		t.Fatal("service not called")
	}
	if e = s.Dispatch(context.Background(), p, raw, allow, launch); !errors.Is(e, ErrPending) || calls.Load() != 1 {
		t.Fatal("uncertain actual request resubmitted", e, calls.Load())
	}
}
