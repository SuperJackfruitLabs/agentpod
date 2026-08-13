package gateway

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/selfupdate"
)

// updateHandler wraps an inner Handler and intercepts the "update" verb to
// trigger an in-process self-update via selfupdate.Apply, then exits so that
// the system supervisor (e.g. systemd Restart=always) can start the new binary.
//
// The exit is conditional on selfupdate.Apply having actually swapped a
// binary: an update request against a node already on the latest release
// answers {"ok":true,"updating":false} and leaves the process alone.
type updateHandler struct {
	inner   Handler
	version string

	// The following fields are unexported and defaulted by NewUpdateHandler.
	// They are overridable in tests for injection.
	apply func(context.Context, selfupdate.Options) (selfupdate.Result, error)
	exit  func(int)
	delay time.Duration
}

// NewUpdateHandler wraps inner with a handler that intercepts the "update" verb.
// When "update" is received the handler calls selfupdate.Apply (resolve latest
// release, download, verify, swap) and then exits — the supervisor restarts the
// process with the new binary. All other verbs are delegated to inner.
func NewUpdateHandler(inner Handler, version string) Handler {
	return &updateHandler{
		inner:   inner,
		version: version,
		apply:   selfupdate.Apply,
		exit:    os.Exit,
		delay:   time.Second,
	}
}

// Handle intercepts "update" and delegates all other verbs to the inner handler.
func (h *updateHandler) Handle(
	ctx context.Context,
	verb string,
	p json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	if verb != "update" {
		return h.inner.Handle(ctx, verb, p, emit)
	}

	// `{"force":true}` re-applies the release the node is already running —
	// the escape hatch for a corrupt binary whose reported version is current.
	// Unreadable params are simply "no options given": failing an update over
	// a malformed payload would be worse than ignoring it.
	var params struct {
		Force bool `json:"force"`
	}
	if len(p) > 0 {
		_ = json.Unmarshal(p, &params)
	}

	res, err := h.apply(ctx, selfupdate.Options{
		CurrentVersion: h.version,
		Force:          params.Force,
	})
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}, false, nil
	}

	out := map[string]any{
		"ok":             true,
		"updating":       res.Updated,
		"tag":            res.LatestTag,
		"currentVersion": res.CurrentVersion,
	}
	if res.Reason != "" {
		out["reason"] = res.Reason
	}

	// Nothing was swapped — the node is already on the latest release, so
	// exiting would restart it to arrive exactly where it started. On Fly that
	// restart is a full VM reboot, costing the station its uptime and every
	// in-flight session on it (issue #296).
	if !res.Updated {
		return out, false, nil
	}

	// Respond to the hub before exiting so it can mark the node as updating.
	// The goroutine gives the dispatcher time to write the response frame.
	go func() {
		time.Sleep(h.delay)
		h.exit(0)
	}()

	return out, false, nil
}

// HandleFrame forwards inbound terminal input/resize frames to the inner handler
// when it implements FrameHandler. The dispatcher (serve) routes such frames via
// a type assertion on the OUTERMOST handler; without this forwarder, wrapping a
// terminalHandler in updateHandler would erase the FrameHandler interface and
// every keystroke would be silently dropped (terminal connects but ignores
// input). Returns nil when the inner handler has no frame support.
func (h *updateHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
