package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/acp"
)

// acpTestRig wires a fake hub ↔ node websocket pair around an acpHandler and
// exposes helpers mirroring dispatch_terminal_test.go.
type acpTestRig struct {
	t      *testing.T
	frames chan []byte
	hub    *websocket.Conn
}

// newACPTestRig starts an httptest websocket "hub", connects the node side,
// and runs the dispatch loop over h.
func newACPTestRig(t *testing.T, h Handler) *acpTestRig {
	t.Helper()

	frames := make(chan []byte, 64)
	hubConnCh := make(chan *websocket.Conn, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		hubConnCh <- c

		ctx := r.Context()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			cp := make([]byte, len(data))
			copy(cp, data)
			select {
			case frames <- cp:
			default: // drop if test is slow (channel is large enough)
			}
		}
	}))
	t.Cleanup(srv.Close)

	nodeConn, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	go serve(context.Background(), nodeConn, h)

	var hubConn *websocket.Conn
	select {
	case hubConn = <-hubConnCh:
	case <-time.After(2 * time.Second):
		t.Fatal("hub connection timeout")
	}

	return &acpTestRig{t: t, frames: frames, hub: hubConn}
}

// writeHub sends a raw JSON string to the node.
func (r *acpTestRig) writeHub(msg string) {
	r.t.Helper()
	if err := r.hub.Write(context.Background(), websocket.MessageText, []byte(msg)); err != nil {
		r.t.Errorf("hub write: %v", err)
	}
}

// readFrame waits for the next frame from the node with a 3-second timeout.
func (r *acpTestRig) readFrame() map[string]any {
	r.t.Helper()
	select {
	case data := <-r.frames:
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			r.t.Fatalf("bad JSON frame: %v – raw: %s", err, data)
		}
		return m
	case <-time.After(3 * time.Second):
		r.t.Fatal("timeout waiting for frame from node")
		return nil
	}
}

// awaitStreamContaining scans stream frames until one's base64-decoded chunk
// contains want, or the deadline passes.
func (r *acpTestRig) awaitStreamContaining(want string) bool {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case data := <-r.frames:
			var m map[string]any
			json.Unmarshal(data, &m)
			if m["type"] != "stream" || m["enc"] != "base64" {
				continue
			}
			if eof, _ := m["eof"].(bool); eof {
				continue
			}
			chunk, _ := m["chunk"].(string)
			decoded, err := base64.StdEncoding.DecodeString(chunk)
			if err == nil && strings.Contains(string(decoded), want) {
				return true
			}
		case <-time.After(200 * time.Millisecond):
			// keep polling
		}
	}
	return false
}

// openACPSession drives acp.open and returns the sessionId.
func (r *acpTestRig) openACPSession() string {
	r.t.Helper()
	r.writeHub(`{"type":"req","id":"open-1","verb":"acp.open","params":{"key":"opencode:test"}}`)

	msg := r.readFrame()
	if msg["type"] != "res" {
		r.t.Fatalf("acp.open: expected res frame, got type=%v", msg["type"])
	}
	if ok, _ := msg["ok"].(bool); !ok {
		r.t.Fatalf("acp.open failed: %v", msg["error"])
	}
	dataMap, ok := msg["data"].(map[string]any)
	if !ok {
		r.t.Fatalf("acp.open: data is %T, want map", msg["data"])
	}
	sessionID, _ := dataMap["sessionId"].(string)
	if sessionID == "" {
		r.t.Fatal("acp.open: empty sessionId")
	}
	return sessionID
}

// catCommandFunc resolves every key to /bin/cat (echoes stdin → stdout,
// exits on stdin EOF), spawned in dir.
func catCommandFunc(dir string) ACPCommandFunc {
	return func(key string) (argv []string, cdir string, env []string, err error) {
		return []string{"/bin/cat"}, dir, nil, nil
	}
}

// failInner is an inner handler that fails the test if any verb reaches it.
func failInner(t *testing.T) Handler {
	return HandlerFunc(func(_ context.Context, v string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		return nil, false, fmt.Errorf("unexpected verb forwarded to inner: %s", v)
	})
}

// TestACPVerbs drives the gateway dispatch layer end-to-end for the ACP verb
// family:
//
//  1. acp.open   → returns {sessionId}
//  2. acp.attach → starts streaming base64 stdout
//  3. input frame (id = sessionId) → line reaches the child's stdin
//     (cat echoes it back as a stream frame)
func TestACPVerbs(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)

	h := NewACPHandler(failInner(t), mgr, catCommandFunc(t.TempDir()))
	rig := newACPTestRig(t, h)

	sessionID := rig.openACPSession()
	t.Logf("sessionId = %s", sessionID)

	// ── acp.attach ───────────────────────────────────────────────────────────
	rig.writeHub(fmt.Sprintf(
		`{"type":"req","id":"attach-1","verb":"acp.attach","params":{"sessionId":"%s"}}`,
		sessionID,
	))

	// Give the attach goroutine time to subscribe before we send input.
	time.Sleep(50 * time.Millisecond)

	// ── input frame: id carries the ACP sessionId ────────────────────────────
	inputB64 := base64.StdEncoding.EncodeToString([]byte(`{"jsonrpc":"2.0","id":1}` + "\n"))
	rig.writeHub(fmt.Sprintf(`{"type":"input","id":"%s","data":"%s"}`, sessionID, inputB64))

	if !rig.awaitStreamContaining("jsonrpc") {
		t.Fatal("no base64 stream frame containing 'jsonrpc' received after input")
	}
}

// TestACPOpenEchoesInstance pins the wire contract from the contract package:
// acp.open echoes the instance it was given (that echo is how the hub detects a
// node that understands per-instance processes) and omits the field entirely
// when the request carried none, so an older hub sees exactly today's result.
func TestACPOpenEchoesInstance(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)

	h := NewACPHandler(failInner(t), mgr, catCommandFunc(t.TempDir()))

	res, _, err := h.Handle(context.Background(), "acp.open",
		json.RawMessage(`{"key":"opencode:test","instance":"tab-2"}`), nil)
	if err != nil {
		t.Fatalf("acp.open: %v", err)
	}
	data := res.(map[string]any)
	if got := data["instance"]; got != "tab-2" {
		t.Fatalf(`result["instance"] = %v, want "tab-2"`, got)
	}
	if data["sessionId"] == "" || data["sessionId"] == nil {
		t.Fatal("missing sessionId")
	}

	legacy, _, err := h.Handle(context.Background(), "acp.open",
		json.RawMessage(`{"key":"opencode:test"}`), nil)
	if err != nil {
		t.Fatalf("legacy acp.open: %v", err)
	}
	legacyData := legacy.(map[string]any)
	if _, present := legacyData["instance"]; present {
		t.Fatalf(`legacy result carries instance=%v, want the field omitted`, legacyData["instance"])
	}
	if legacyData["sessionId"] == data["sessionId"] {
		t.Fatal("the legacy (instance-less) open reused the named instance's session")
	}
}

// TestACPOpenDistinctInstancesGetDistinctSessions pins that two hub sessions on
// one station key each get their own ACP child through the gateway verb, and
// that re-opening the same instance is still idempotent.
func TestACPOpenDistinctInstancesGetDistinctSessions(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)

	h := NewACPHandler(failInner(t), mgr, catCommandFunc(t.TempDir()))
	open := func(instance string) string {
		t.Helper()
		res, _, err := h.Handle(context.Background(), "acp.open",
			json.RawMessage(fmt.Sprintf(`{"key":"opencode:test","instance":%q}`, instance)), nil)
		if err != nil {
			t.Fatalf("acp.open %q: %v", instance, err)
		}
		return res.(map[string]any)["sessionId"].(string)
	}

	one, two := open("tab-1"), open("tab-2")
	if one == two {
		t.Fatalf("both instances got sessionId %q", one)
	}
	if again := open("tab-1"); again != one {
		t.Fatalf("re-open of tab-1 = %q, want the existing %q", again, one)
	}
}

// TestACPCloseEmitsExitEvent verifies that closing an ACP session delivers a
// final stream frame whose decoded payload is the {"event":"exit",...} JSON
// to an attached subscriber.
func TestACPCloseEmitsExitEvent(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)

	h := NewACPHandler(failInner(t), mgr, catCommandFunc(t.TempDir()))
	rig := newACPTestRig(t, h)

	sessionID := rig.openACPSession()

	rig.writeHub(fmt.Sprintf(
		`{"type":"req","id":"attach-1","verb":"acp.attach","params":{"sessionId":"%s"}}`,
		sessionID,
	))
	time.Sleep(50 * time.Millisecond)

	// Kill the child via acp.close and expect the exit event on the stream.
	rig.writeHub(fmt.Sprintf(
		`{"type":"req","id":"close-1","verb":"acp.close","params":{"sessionId":"%s"}}`,
		sessionID,
	))

	if !rig.awaitStreamContaining(`"event":"exit"`) {
		t.Fatal(`no stream frame with "event":"exit" received after acp.close`)
	}

	if _, ok := mgr.Get(sessionID); ok {
		t.Fatal("session should be removed from the manager after acp.close")
	}
}

// TestACPAttachDeliversBacklogBeforeExit is the regression test for buffered
// stdout being silently dropped at exit: the child writes a paced burst and
// exits while a slow consumer is still draining its per-subscriber queue.
// Every line must reach the consumer BEFORE the exit event frame — the
// backlog must never be discarded in favor of the exit event.
func TestACPAttachDeliversBacklogBeforeExit(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)

	dir := t.TempDir()
	burstCmd := ACPCommandFunc(func(string) ([]string, string, []string, error) {
		// ~20 distinct chunks (paced so the fast read loop sees separate
		// writes), then immediate exit.
		return []string{"/bin/sh", "-c",
			"i=1; while [ $i -le 20 ]; do echo line$i; sleep 0.01; i=$((i+1)); done",
		}, dir, nil, nil
	})
	h := NewACPHandler(failInner(t), mgr, burstCmd)

	res, _, err := h.Handle(context.Background(), "acp.open", json.RawMessage(`{"key":"k"}`), nil)
	if err != nil {
		t.Fatalf("acp.open: %v", err)
	}
	sessionID := res.(map[string]any)["sessionId"].(string)

	var mu sync.Mutex
	var frames []string // decoded frame payloads, in emit order
	slowEmit := func(_ int, chunk string, _ bool, _ string) error {
		time.Sleep(30 * time.Millisecond) // slow consumer: backlog builds
		decoded, err := base64.StdEncoding.DecodeString(chunk)
		if err != nil {
			return err
		}
		mu.Lock()
		frames = append(frames, string(decoded))
		mu.Unlock()
		return nil
	}

	attachDone := make(chan error, 1)
	go func() {
		_, _, err := h.Handle(context.Background(), "acp.attach",
			json.RawMessage(fmt.Sprintf(`{"sessionId":%q}`, sessionID)), slowEmit)
		attachDone <- err
	}()

	select {
	case err := <-attachDone:
		if err != nil {
			t.Fatalf("acp.attach: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("attach did not return after child exit")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(frames) < 2 {
		t.Fatalf("got %d frames, want chunks plus an exit event", len(frames))
	}
	last := frames[len(frames)-1]
	if !strings.Contains(last, `"event":"exit"`) {
		t.Fatalf("last frame = %q, want the exit event", last)
	}
	beforeExit := strings.Join(frames[:len(frames)-1], "")
	for i := 1; i <= 20; i++ {
		want := fmt.Sprintf("line%d\n", i)
		if !strings.Contains(beforeExit, want) {
			t.Fatalf("line%d missing before the exit event (backlog dropped); %d frames", i, len(frames))
		}
	}
}

// TestACPAttachDetachUnregistersExitHook is the regression test for exit-hook
// leakage: every attach/detach cycle on a long-lived session must remove its
// OnExit closure, returning the session's registered-callback count to
// baseline.
func TestACPAttachDetachUnregistersExitHook(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)

	h := NewACPHandler(failInner(t), mgr, catCommandFunc(t.TempDir()))

	res, _, err := h.Handle(context.Background(), "acp.open", json.RawMessage(`{"key":"k"}`), nil)
	if err != nil {
		t.Fatalf("acp.open: %v", err)
	}
	sessionID := res.(map[string]any)["sessionId"].(string)
	sess, ok := mgr.Get(sessionID)
	if !ok {
		t.Fatal("session not registered")
	}
	base := sess.OnExitCount() // the manager's own removal hook

	noopEmit := func(int, string, bool, string) error { return nil }
	params := json.RawMessage(fmt.Sprintf(`{"sessionId":%q}`, sessionID))

	for i := 0; i < 5; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		attachDone := make(chan struct{})
		go func() {
			defer close(attachDone)
			_, _, _ = h.Handle(ctx, "acp.attach", params, noopEmit)
		}()

		// Wait until this attach has registered its exit hook, then detach.
		deadline := time.Now().Add(3 * time.Second)
		for sess.OnExitCount() == base && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if sess.OnExitCount() != base+1 {
			cancel()
			t.Fatalf("iteration %d: OnExitCount = %d, want %d after attach", i, sess.OnExitCount(), base+1)
		}
		cancel()
		select {
		case <-attachDone:
		case <-time.After(3 * time.Second):
			t.Fatalf("iteration %d: attach did not return after cancel", i)
		}
		if got := sess.OnExitCount(); got != base {
			t.Fatalf("iteration %d: OnExitCount = %d after detach, want baseline %d (exit hook leaked)", i, got, base)
		}
	}
}

// recordingFrameHandler is a stub inner handler that records HandleFrame calls.
type recordingFrameHandler struct {
	Handler

	mu    sync.Mutex
	calls []string // "<frameType>:<id>"
}

func (r *recordingFrameHandler) HandleFrame(frameType, id string, _ json.RawMessage) error {
	r.mu.Lock()
	r.calls = append(r.calls, frameType+":"+id)
	r.mu.Unlock()
	return nil
}

func (r *recordingFrameHandler) recorded() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...)
}

// TestACPInputFrameChainPassthrough verifies that input frames whose id does
// NOT belong to an ACP session are forwarded to the inner handler (terminal),
// preserving the existing frame chain.
func TestACPInputFrameChainPassthrough(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)

	inner := &recordingFrameHandler{Handler: failInner(t)}
	h := NewACPHandler(inner, mgr, catCommandFunc(t.TempDir()))

	fh, ok := h.(FrameHandler)
	if !ok {
		t.Fatal("acpHandler must implement FrameHandler")
	}

	raw := json.RawMessage(`{"type":"input","id":"attach-77","data":"aGkK"}`)
	if err := fh.HandleFrame("input", "attach-77", raw); err != nil {
		t.Fatalf("HandleFrame: %v", err)
	}

	got := inner.recorded()
	if len(got) != 1 || got[0] != "input:attach-77" {
		t.Fatalf("inner handler calls = %v, want [input:attach-77]", got)
	}

	// A frame for a live ACP session must NOT reach the inner handler.
	sess, err := mgr.Open("opencode:test", "", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	data := base64.StdEncoding.EncodeToString([]byte("x"))
	rawACP := json.RawMessage(fmt.Sprintf(`{"type":"input","id":"%s","data":"%s"}`, sess.ID(), data))
	if err := fh.HandleFrame("input", sess.ID(), rawACP); err != nil {
		t.Fatalf("HandleFrame (acp session): %v", err)
	}
	if got := inner.recorded(); len(got) != 1 {
		t.Fatalf("acp-session input leaked to inner handler: %v", got)
	}
}
