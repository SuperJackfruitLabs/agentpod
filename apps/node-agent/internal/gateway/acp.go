package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/acp"
)

// ACPCommandFunc resolves the ACP spawn command for a station key: argv is the
// full command line, dir the working directory, env extra KEY=VALUE pairs
// appended to the inherited environment. The dispatcher resolves the actual
// descriptor capability, keeping this package free of a direct descriptor
// import (mirrors LifecycleFunc).
type ACPCommandFunc func(key string) (argv []string, dir string, env []string, err error)

// acpAttachState tracks one active acp.attach subscription. emit calls come
// from two goroutines — stdout chunks from the session's dispatcher, the exit
// event from the session's reaper — so mu serializes them, keeping stream seq
// numbers monotonic and guaranteeing nothing is emitted after the exit event.
type acpAttachState struct {
	unsub func()

	mu     sync.Mutex
	seq    int
	done   bool // set once the exit event has been emitted
	failed bool // set once emit errored; suppresses further chunk frames
	emit   func(seq int, chunk string, eof bool, enc string) error

	exited chan struct{} // closed after the exit event; unblocks the attach handler
}

// emitChunk sends one base64 stream frame unless the exit event has already
// been emitted or a previous emit failed. On emit failure the subscriber is
// detached (mirroring term.attach's unsub-on-emit-error); the unsubscribe must
// run async because it blocks until the session dispatcher — the goroutine
// calling this very function — has drained and returned.
func (st *acpAttachState) emitChunk(chunk []byte) {
	encoded := base64.StdEncoding.EncodeToString(chunk)
	st.mu.Lock()
	if st.done || st.failed {
		st.mu.Unlock()
		return
	}
	if err := st.emit(st.seq, encoded, false, "base64"); err != nil {
		// Hub disconnected or attach cancelled — detach this subscriber.
		st.failed = true
		st.mu.Unlock()
		go st.unsub()
		return
	}
	st.seq++
	st.mu.Unlock()
}

// emitExit sends the final stream frame whose decoded payload is the JSON
// {"event":"exit","reason":<reason>} exactly once, then unblocks the attach
// handler. Idempotent.
func (st *acpAttachState) emitExit(reason string) {
	st.mu.Lock()
	if st.done {
		st.mu.Unlock()
		return
	}
	st.done = true
	if payload, err := json.Marshal(map[string]string{"event": "exit", "reason": reason}); err == nil {
		_ = st.emit(st.seq, base64.StdEncoding.EncodeToString(payload), false, "base64")
		st.seq++
	}
	st.mu.Unlock()
	close(st.exited)
}

// acpHandler wraps an inner Handler and adds routing for the three ACP verbs
// (acp.open, acp.attach, acp.close) plus inbound input frame handling via the
// FrameHandler interface. Input frames whose id is not a live ACP session ID
// pass through to the inner handler (terminal), preserving the frame chain.
// All per-attach state lives on the attach request's own stack — input frames
// are correlated by session ID against the manager, so no attach registry is
// needed.
type acpHandler struct {
	inner Handler
	mgr   *acp.Manager
	cmdFn ACPCommandFunc
}

// NewACPHandler wraps inner with ACP verb and input frame support.
//   - mgr is shared across the lifetime of the gateway connection.
//   - cmdFn resolves the harness ACP spawn command for acp.open.
//
// The returned handler implements both Handler and FrameHandler.
func NewACPHandler(inner Handler, mgr *acp.Manager, cmdFn ACPCommandFunc) Handler {
	return &acpHandler{
		inner: inner,
		mgr:   mgr,
		cmdFn: cmdFn,
	}
}

// Handle routes acp.* verbs to the local handlers and delegates everything
// else to the wrapped inner handler.
func (h *acpHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	switch verb {
	case "acp.open":
		return h.handleOpen(params)
	case "acp.attach":
		return h.handleAttach(ctx, params, emit)
	case "acp.close":
		return h.handleClose(params)
	default:
		return h.inner.Handle(ctx, verb, params, emit)
	}
}

// handleOpen resolves the ACP spawn command for key, spawns (or reuses) the
// session for the (key, instance) pair, and returns {sessionId} — plus the
// echoed instance when the request carried one. The echo is how the hub tells a
// node that understands per-instance processes from an older one; omitting the
// field for an instance-less request keeps the legacy result shape byte-exact.
func (h *acpHandler) handleOpen(params json.RawMessage) (any, bool, error) {
	var p struct {
		Key      string `json:"key"`
		Instance string `json:"instance"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("acp.open: bad params: %w", err)
	}
	if h.cmdFn == nil {
		return nil, false, fmt.Errorf("acp.open: acp not configured for this node")
	}

	argv, dir, env, err := h.cmdFn(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("acp.open: %w", err)
	}

	sess, err := h.mgr.Open(p.Key, p.Instance, argv, dir, env)
	if err != nil {
		return nil, false, fmt.Errorf("acp.open: %w", err)
	}

	res := map[string]any{"sessionId": sess.ID()}
	if p.Instance != "" {
		res["instance"] = p.Instance
	}
	return res, false, nil
}

// handleAttach subscribes to the session's stdout stream and forwards each
// chunk as a base64-encoded stream frame. It blocks until the context is
// cancelled (detach via cancel frame) or the child exits — on exit every
// chunk already queued for this subscriber is delivered first (Session unsub
// blocks until the backlog has drained), then a final frame carrying
// {"event":"exit","reason":...} is emitted. On context cancellation the
// subscriber is removed and its exit hook unregistered WITHOUT closing the
// session.
//
// The exit hook is registered per attach (not at open time) for two reasons:
// Session.OnExit fires immediately when the child has already exited, so an
// attach racing the exit still gets its event instead of blocking forever;
// and the returned unregister func lets a detach drop the hook so long-lived
// sessions don't accumulate one closure per attach/detach cycle.
func (h *acpHandler) handleAttach(
	ctx context.Context,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	var p struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, true, fmt.Errorf("acp.attach: bad params: %w", err)
	}

	sess, ok := h.mgr.Get(p.SessionID)
	if !ok {
		return nil, true, fmt.Errorf("acp.attach: session not found: %s", p.SessionID)
	}

	st := &acpAttachState{
		emit:   emit,
		exited: make(chan struct{}),
	}
	st.unsub = sess.Subscribe(st.emitChunk)

	// Fires exactly once when the child exits (immediately if already exited).
	// unsub blocks until this subscriber's queued backlog has been delivered,
	// so the exit frame always trails the child's final output.
	unregExit := sess.OnExit(func(reason string) {
		st.unsub()
		st.emitExit(reason)
	})

	select {
	case <-st.exited:
		// Child exited; the backlog and exit event have been emitted.
	case <-ctx.Done():
		// cancel frame received: detach this subscriber and drop its exit
		// hook, do NOT close the session (the child keeps running; another
		// client can re-attach).
		unregExit()
		st.unsub()
	}

	return nil, true, nil
}

// handleClose terminates the named session and removes it from the manager.
// Attached subscribers receive their exit event via the per-attach OnExit
// hooks once the child has been reaped.
func (h *acpHandler) handleClose(params json.RawMessage) (any, bool, error) {
	var p struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("acp.close: bad params: %w", err)
	}

	if err := h.mgr.Close(p.SessionID); err != nil {
		return nil, false, fmt.Errorf("acp.close: %w", err)
	}

	return map[string]any{"ok": true}, false, nil
}

// HandleFrame implements FrameHandler for inbound ACP input frames. ACP input
// rides the shared InputMsg envelope with id carrying the ACP session ID; a
// frame whose id is not a live ACP session (e.g. a terminal attach request ID)
// passes through to the inner handler unchanged. ACP has no resize.
func (h *acpHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if frameType == "input" {
		if sess, ok := h.mgr.Get(id); ok {
			var f struct {
				Data string `json:"data"`
			}
			if err := json.Unmarshal(raw, &f); err != nil {
				return fmt.Errorf("acp input: bad frame: %w", err)
			}
			data, err := base64.StdEncoding.DecodeString(f.Data)
			if err != nil {
				return fmt.Errorf("acp input: bad base64: %w", err)
			}
			return sess.Write(data)
		}
	}

	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
