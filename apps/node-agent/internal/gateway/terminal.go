package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fsops"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/terminal"
)

// WorkspaceResolver maps a station key to the absolute path of its workspace
// directory (used as the cwd when spawning a terminal session).
type WorkspaceResolver interface {
	Workspace(key string) (string, error)
}

// WorkspaceFunc is a functional adapter for WorkspaceResolver.
type WorkspaceFunc func(key string) (string, error)

// Workspace implements WorkspaceResolver.
func (f WorkspaceFunc) Workspace(key string) (string, error) { return f(key) }

// LifecycleFunc performs a lifecycle action ("stop", "start", or "restart") on
// the station identified by key. "restart" = Stop then Start. The dispatcher
// resolves the actual Lifecycle implementation, keeping this package free of
// a direct descriptor import.
type LifecycleFunc func(key, action string) error

// attachState tracks an active term.attach subscription.
type attachState struct {
	sessionID string
	unsub     func()
}

// terminalHandler wraps an inner Handler and adds routing for the three
// terminal verbs (term.open, term.attach, term.close) plus inbound
// input/resize frame handling via the FrameHandler interface.
type terminalHandler struct {
	inner       Handler
	resolver    WorkspaceResolver
	mgr         *terminal.Manager
	lifecycleFn LifecycleFunc // nil if lifecycle not configured
	// envFn is the extra environment a station's shell starts with (its git identity, today).
	// nil means none.
	envFn func(key string) []string

	attachMu sync.Mutex
	attaches map[string]*attachState // keyed by attach request ID
}

// NewTerminalHandler wraps inner with terminal verb and input/resize support.
//   - resolver provides workspace path lookup for term.open.
//   - mgr is shared across the lifetime of the gateway connection.
//   - lifecycleFn (optional) is called by the "lifecycle" verb handler; if nil,
//     the lifecycle verb returns an error.
//
// The returned handler implements both Handler and FrameHandler.
func NewTerminalHandler(inner Handler, resolver WorkspaceResolver, mgr *terminal.Manager, lifecycleFn ...LifecycleFunc) Handler {
	var lcFn LifecycleFunc
	if len(lifecycleFn) > 0 {
		lcFn = lifecycleFn[0]
	}
	return &terminalHandler{
		inner:       inner,
		resolver:    resolver,
		mgr:         mgr,
		lifecycleFn: lcFn,
		attaches:    make(map[string]*attachState),
	}
}

// NewTerminalHandlerWithEnv is NewTerminalHandler whose shells start with envFn(stationKey) in
// their environment — so a commit made by hand in a station's terminal carries the same author as
// one its harness makes.
func NewTerminalHandlerWithEnv(inner Handler, resolver WorkspaceResolver, mgr *terminal.Manager, envFn func(key string) []string, lifecycleFn ...LifecycleFunc) Handler {
	h := NewTerminalHandler(inner, resolver, mgr, lifecycleFn...).(*terminalHandler)
	h.envFn = envFn
	return h
}

// Handle routes term.* verbs to the local handlers and delegates everything
// else to the wrapped inner handler.
func (h *terminalHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	switch verb {
	case "term.open":
		return h.handleTermOpen(params)
	case "term.attach":
		return h.handleTermAttach(ctx, params, emit)
	case "term.close":
		return h.handleTermClose(params)
	case "fs.write":
		return h.handleFsWrite(params)
	case "fs.mkdir":
		return h.handleFsMkdir(params)
	case "fs.move":
		return h.handleFsMove(params)
	case "fs.delete":
		return h.handleFsDelete(params)
	case "lifecycle":
		return h.handleLifecycle(ctx, params)
	default:
		return h.inner.Handle(ctx, verb, params, emit)
	}
}

// handleTermOpen resolves the workspace for key, spawns (or reuses) a PTY
// session, and returns {sessionId}.
func (h *terminalHandler) handleTermOpen(params json.RawMessage) (any, bool, error) {
	var p struct {
		Key  string `json:"key"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("term.open: bad params: %w", err)
	}

	workspace, err := h.resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("term.open: workspace: %w", err)
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}

	var env []string
	if h.envFn != nil {
		env = h.envFn(p.Key)
	}
	sess, err := h.mgr.OpenWithEnv(p.Key, shell, workspace, p.Cols, p.Rows, env)
	if err != nil {
		return nil, false, fmt.Errorf("term.open: %w", err)
	}

	return map[string]any{"sessionId": sess.ID}, false, nil
}

// handleTermAttach subscribes to the session's output stream and forwards each
// chunk as a base64-encoded stream frame. It blocks until the context is
// cancelled (detach via cancel frame) or the session ends. On context
// cancellation the subscriber is removed WITHOUT closing the session.
func (h *terminalHandler) handleTermAttach(
	ctx context.Context,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	var p struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, true, fmt.Errorf("term.attach: bad params: %w", err)
	}

	sess, ok := h.mgr.Get(p.SessionID)
	if !ok {
		return nil, true, fmt.Errorf("term.attach: session not found: %s", p.SessionID)
	}

	// Extract the attach request ID embedded in ctx by serve() so we can key
	// the attach map and allow input/resize frames to find this session.
	reqID, _ := ctx.Value(reqIDKey{}).(string)

	ch, unsub := sess.Subscribe()

	h.attachMu.Lock()
	h.attaches[reqID] = &attachState{sessionID: p.SessionID, unsub: unsub}
	h.attachMu.Unlock()

	defer func() {
		h.attachMu.Lock()
		delete(h.attaches, reqID)
		h.attachMu.Unlock()
	}()

	seq := 0
loop:
	for {
		select {
		case chunk, ok := <-ch:
			if !ok {
				// Session ended; subscriber channel closed.
				break loop
			}
			encoded := base64.StdEncoding.EncodeToString(chunk)
			if err := emit(seq, encoded, false, "base64"); err != nil {
				// Hub disconnected or context cancelled mid-write — detach.
				unsub()
				break loop
			}
			seq++
		case <-ctx.Done():
			// cancel frame received: detach this subscriber, do NOT close the
			// session (PTY keeps running; another client can re-attach).
			unsub()
			break loop
		}
	}

	return nil, true, nil
}

// handleTermClose terminates the named session and removes it from the manager.
func (h *terminalHandler) handleTermClose(params json.RawMessage) (any, bool, error) {
	var p struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("term.close: bad params: %w", err)
	}

	if err := h.mgr.Close(p.SessionID); err != nil {
		return nil, false, fmt.Errorf("term.close: %w", err)
	}

	return map[string]any{"ok": true}, false, nil
}

// handleFsWrite resolves the workspace for key and writes content to path,
// returning {bytesWritten, backupPath?}.
func (h *terminalHandler) handleFsWrite(params json.RawMessage) (any, bool, error) {
	var p struct {
		Key      string `json:"key"`
		Path     string `json:"path"`
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
		Backup   bool   `json:"backup"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("fs.write: bad params: %w", err)
	}
	workspace, err := h.resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("fs.write: workspace: %w", err)
	}
	n, backupPath, err := fsops.Write(workspace, p.Path, p.Content, p.Encoding, p.Backup)
	if err != nil {
		return nil, false, fmt.Errorf("fs.write: %w", err)
	}
	result := map[string]any{"bytesWritten": n}
	if backupPath != "" {
		result["backupPath"] = backupPath
	}
	return result, false, nil
}

// handleFsMkdir resolves the workspace for key and creates the directory at path.
func (h *terminalHandler) handleFsMkdir(params json.RawMessage) (any, bool, error) {
	var p struct {
		Key  string `json:"key"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("fs.mkdir: bad params: %w", err)
	}
	workspace, err := h.resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("fs.mkdir: workspace: %w", err)
	}
	if err := fsops.Mkdir(workspace, p.Path); err != nil {
		return nil, false, fmt.Errorf("fs.mkdir: %w", err)
	}
	return map[string]any{"ok": true}, false, nil
}

// handleFsMove resolves the workspace for key and renames from to to.
func (h *terminalHandler) handleFsMove(params json.RawMessage) (any, bool, error) {
	var p struct {
		Key  string `json:"key"`
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("fs.move: bad params: %w", err)
	}
	workspace, err := h.resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("fs.move: workspace: %w", err)
	}
	if err := fsops.Move(workspace, p.From, p.To); err != nil {
		return nil, false, fmt.Errorf("fs.move: %w", err)
	}
	return map[string]any{"ok": true}, false, nil
}

// handleFsDelete resolves the workspace for key and deletes path.
func (h *terminalHandler) handleFsDelete(params json.RawMessage) (any, bool, error) {
	var p struct {
		Key       string `json:"key"`
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("fs.delete: bad params: %w", err)
	}
	workspace, err := h.resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("fs.delete: workspace: %w", err)
	}
	if err := fsops.Delete(workspace, p.Path, p.Recursive); err != nil {
		return nil, false, fmt.Errorf("fs.delete: %w", err)
	}
	return map[string]any{"ok": true}, false, nil
}

// handleLifecycle performs a lifecycle action and returns the post-action
// health snapshot by delegating back to the inner handler's "health" verb.
func (h *terminalHandler) handleLifecycle(ctx context.Context, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key    string `json:"key"`
		Action string `json:"action"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("lifecycle: bad params: %w", err)
	}
	if h.lifecycleFn == nil {
		return nil, false, fmt.Errorf("lifecycle: not configured for this node")
	}
	if err := h.lifecycleFn(p.Key, p.Action); err != nil {
		return nil, false, err
	}
	// Return post-action health snapshot via the inner handler.
	healthParams, _ := json.Marshal(map[string]string{"key": p.Key})
	return h.inner.Handle(ctx, "health", healthParams, nil)
}

// HandleFrame implements FrameHandler for inbound terminal input/resize frames.
// The id is the attach request ID that was used in the corresponding term.attach req.
func (h *terminalHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	h.attachMu.Lock()
	st, ok := h.attaches[id]
	h.attachMu.Unlock()
	if !ok {
		return nil // no active attach for this id — ignore
	}

	sess, ok := h.mgr.Get(st.sessionID)
	if !ok {
		return nil // session has gone away
	}

	switch frameType {
	case "input":
		var f struct {
			Data string `json:"data"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			return fmt.Errorf("input: bad frame: %w", err)
		}
		data, err := base64.StdEncoding.DecodeString(f.Data)
		if err != nil {
			return fmt.Errorf("input: bad base64: %w", err)
		}
		return sess.Write(data)

	case "resize":
		var f struct {
			Cols uint16 `json:"cols"`
			Rows uint16 `json:"rows"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			return fmt.Errorf("resize: bad frame: %w", err)
		}
		return sess.Resize(f.Cols, f.Rows)
	}

	return nil
}
