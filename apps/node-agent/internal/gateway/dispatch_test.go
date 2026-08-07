package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestDispatchUnaryResponse(t *testing.T) {
	got := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := websocket.Accept(w, r, nil)
		defer c.Close(websocket.StatusNormalClosure, "")
		c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"req","id":"1","verb":"ping","params":{}}`))
		_, data, _ := c.Read(context.Background())
		got <- string(data)
	}))
	defer srv.Close()

	c, _, _ := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	go serve(context.Background(), c, HandlerFunc(func(ctx context.Context, verb string, p json.RawMessage, emit func(int, string, bool, string) error) (any, bool, error) {
		return map[string]bool{"pong": true}, false, nil
	}))

	select {
	case m := <-got:
		if !strings.Contains(m, `"type":"res"`) || !strings.Contains(m, `"pong":true`) {
			t.Fatalf("got %s", m)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no response")
	}
}

func TestDispatchCancelRequest(t *testing.T) {
	cancelSeen := make(chan struct{}, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := websocket.Accept(w, r, nil)
		defer c.Close(websocket.StatusNormalClosure, "")
		// send req then immediately send cancel
		c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"req","id":"42","verb":"slow","params":{}}`))
		c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"cancel","id":"42"}`))
		// wait a bit then close
		time.Sleep(500 * time.Millisecond)
	}))
	defer srv.Close()

	c, _, _ := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	go serve(context.Background(), c, HandlerFunc(func(ctx context.Context, verb string, p json.RawMessage, emit func(int, string, bool, string) error) (any, bool, error) {
		// block until cancelled
		<-ctx.Done()
		cancelSeen <- struct{}{}
		return nil, false, ctx.Err()
	}))

	select {
	case <-cancelSeen:
		// handler saw cancellation — pass
	case <-time.After(2 * time.Second):
		t.Fatal("handler context never cancelled")
	}
}

// TestServeLogsReadLoopExit verifies the read loop logs why it stopped —
// the underlying WS close error was previously discarded, hiding the real
// disconnect cause behind a later "use of closed network connection" write
// failure.
func TestServeLogsReadLoopExit(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := websocket.Accept(w, r, nil)
		// Abruptly close the underlying connection from the server side.
		c.CloseNow()
	}))
	defer srv.Close()

	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()

	done := make(chan struct{})
	go func() {
		serve(ctx, c, stubHandler)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serve did not exit after server closed the connection")
	}
	if !strings.Contains(buf.String(), "read loop closed") {
		t.Fatalf("read-loop exit not logged; log output: %q", buf.String())
	}
}
