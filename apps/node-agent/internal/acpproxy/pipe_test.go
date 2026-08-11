package acpproxy

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// rw joins a reader and a writer into one io.ReadWriter, standing in for a
// socket without needing one.
type rw struct {
	io.Reader
	io.Writer
}

// syncBuf is an io.Writer safe for the two concurrent copies inside Pipe.
type syncBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// waitFor polls until cond holds, failing the test if it never does. Pipe's
// copies are concurrent, so assertions have to wait for them rather than assume
// they have run.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for !cond() {
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestPipeCarriesBothDirections(t *testing.T) {
	// The socket stays open for the duration. Letting both sides EOF instantly
	// races the two copies against Pipe's first-to-finish return, and a socket
	// that closes before its first frame is not a real scenario anyway.
	editorIn := strings.NewReader(`{"jsonrpc":"2.0","method":"initialize"}` + "\n")
	sockR, sockW := io.Pipe()
	toSocket, toEditor := &syncBuf{}, &syncBuf{}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		_ = Pipe(ctx, rw{Reader: sockR, Writer: toSocket}, editorIn, toEditor)
		close(done)
	}()

	waitFor(t, "editor→socket", func() bool { return strings.Contains(toSocket.String(), `"initialize"`) })

	if _, err := sockW.Write([]byte(`{"jsonrpc":"2.0","result":{}}` + "\n")); err != nil {
		t.Fatalf("write to socket: %v", err)
	}
	waitFor(t, "socket→editor", func() bool { return strings.Contains(toEditor.String(), `"result"`) })

	sockW.Close()
	cancel()
	<-done
}

func TestPipeReturnsWhenEditorClosesStdin(t *testing.T) {
	// An editor exiting closes stdin. The proxy must return rather than hang,
	// or every abandoned editor leaves a session live on the hub.
	done := make(chan error, 1)
	go func() {
		done <- Pipe(context.Background(),
			rw{Reader: strings.NewReader(""), Writer: io.Discard},
			strings.NewReader(""), io.Discard)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Pipe did not return when both sides ended")
	}
}

func TestPipeReturnsWhenContextIsCancelled(t *testing.T) {
	// Ctrl-C must end the process even mid-conversation, with neither side
	// having closed.
	pr, pw := io.Pipe() // never written to, never closed: blocks forever
	defer pw.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Pipe(ctx, rw{Reader: pr, Writer: io.Discard}, pr, io.Discard)
	}()

	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Pipe ignored a cancelled context")
	}
}

func TestPipeDoesNotInspectFrames(t *testing.T) {
	// The pipe must be transparent. If it ever parses ACP, the boundary is in
	// the wrong place — so prove that malformed JSON and an unknown future
	// method both travel through untouched.
	//
	// The socket read side stays OPEN here rather than returning EOF. A socket
	// that EOFs before the first frame is not a real scenario, and modelling it
	// races the editor→socket copy against Pipe's first-to-finish return.
	junk := "not json at all\n" + `{"jsonrpc":"2.0","method":"some/future/method/v9"}` + "\n"
	toSocket := &syncBuf{}

	sockR, sockW := io.Pipe() // open until we close it
	defer sockW.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		_ = Pipe(ctx, rw{Reader: sockR, Writer: toSocket}, strings.NewReader(junk), io.Discard)
		close(done)
	}()

	waitFor(t, "the stream to pass through unaltered", func() bool { return toSocket.String() == junk })
	cancel()
	<-done
}

func TestPipeReturnsWhenTheSocketClosesFirst(t *testing.T) {
	// The liveness case that shapes the semantics above: the hub ends the
	// session while the editor is still sitting on stdin with nothing to say.
	// Pipe must return, or the process hangs holding a dead session.
	editorStdin, _ := io.Pipe() // blocks forever; never written, never closed

	done := make(chan struct{})
	go func() {
		_ = Pipe(context.Background(),
			rw{Reader: strings.NewReader(""), Writer: io.Discard}, // socket EOFs
			editorStdin, io.Discard)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Pipe hung after the socket closed — an abandoned editor would hold a live session")
	}
}
