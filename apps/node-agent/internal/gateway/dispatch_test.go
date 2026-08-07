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

// TestCancelStreamDoesNotKillConnection reproduces the fleet-wide disconnect
// bug: cancelling an active stream while a chunk write is in flight closed
// the ENTIRE gateway connection (coder/websocket closes the conn when a
// Write's ctx is cancelled mid-write — conn.go setupWriteTimeout). The
// connection must survive a stream cancel and keep serving other requests.
func TestCancelStreamDoesNotKillConnection(t *testing.T) {
	type serverConn struct {
		c *websocket.Conn
	}
	connCh := make(chan serverConn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		connCh <- serverConn{c}
		// Keep the handler alive; the test drives the conn.
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cli, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cli.CloseNow()
	cli.SetReadLimit(-1)

	// Streaming handler: emits 64KB chunks until emit errors (like a log tail).
	chunk := strings.Repeat("x", 64*1024)
	h := HandlerFunc(func(hctx context.Context, verb string, _ json.RawMessage, emit func(int, string, bool, string) error) (any, bool, error) {
		if verb == "ping" {
			return "pong", false, nil
		}
		for i := 0; ; i++ {
			if err := emit(i, chunk, false, ""); err != nil {
				return nil, true, nil
			}
		}
	})
	go serve(ctx, cli, h)

	sc := <-connCh
	sc.c.SetReadLimit(-1)
	srvCtx := context.Background()

	// Start the stream.
	req, _ := json.Marshal(map[string]any{"type": "req", "id": "s1", "verb": "tail", "params": map[string]any{}})
	if err := sc.c.Write(srvCtx, websocket.MessageText, req); err != nil {
		t.Fatal(err)
	}
	// Read ONE frame, then stop reading so the agent's stream writes block on
	// TCP backpressure — guaranteeing a write is in flight when cancel lands.
	if _, _, err := sc.c.Read(srvCtx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond) // let buffers fill and a write block

	cancelMsg, _ := json.Marshal(map[string]any{"type": "cancel", "id": "s1"})
	if err := sc.c.Write(srvCtx, websocket.MessageText, cancelMsg); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond) // window where the old code closed the conn

	// Drain stream frames and send a ping; the connection must still answer.
	ping, _ := json.Marshal(map[string]any{"type": "req", "id": "p1", "verb": "ping", "params": map[string]any{}})
	if err := sc.c.Write(srvCtx, websocket.MessageText, ping); err != nil {
		t.Fatalf("ping write failed — connection already dead: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		readCtx, rcancel := context.WithTimeout(srvCtx, time.Second)
		_, raw, err := sc.c.Read(readCtx)
		rcancel()
		if err != nil {
			t.Fatalf("connection died after stream cancel: %v", err)
		}
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		if m["type"] == "res" && m["id"] == "p1" {
			if ok, _ := m["ok"].(bool); !ok {
				t.Fatalf("ping res not ok: %v", m)
			}
			return // connection survived the cancel
		}
	}
	t.Fatal("never received ping res after stream cancel")
}
