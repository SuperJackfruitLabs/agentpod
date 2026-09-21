package gateway

import (
	"context"
	"encoding/json"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/posture"
)

// NodeCapabilities is what this node advertises about ITSELF, as opposed to
// about a station. Sent in the hello frame on every connect, which is why node
// capabilities cannot go stale the way station capabilities could — those were
// written only at adoption and needed an explicit refresh to fix.
var NodeCapabilities = []string{"posture"}

// postureHandler wraps an inner Handler and adds the node-level posture verb.
type postureHandler struct {
	inner        Handler
	stationCount func() int
}

// NewPostureHandler wraps inner with posture.scan.
//
// stationCount is injected rather than detected here so the handler has no
// dependency on the descriptor layer — the same separation posture.Scan uses.
func NewPostureHandler(inner Handler, stationCount func() int) Handler {
	return &postureHandler{inner: inner, stationCount: stationCount}
}

func (h *postureHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	if verb != "posture.scan" {
		return h.inner.Handle(ctx, verb, params, emit)
	}

	// Params are deliberately ignored: a node-level scan has nothing to key on,
	// and rejecting unexpected fields would break compatibility for no gain.
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, false, err
	}

	n := 0
	if h.stationCount != nil {
		n = h.stationCount()
	}
	return posture.Scan(ctx, home, posture.KnownHarnesses(), n), false, nil
}

// HandleFrame preserves terminal and ACP input frames while this handler adds
// only the node-level posture.scan request. See changesetHandler.HandleFrame
// for why every wrapper in the production chain must retain FrameHandler.
func (h *postureHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
