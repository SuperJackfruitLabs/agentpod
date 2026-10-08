package gateway

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gitidentity"
)

// gitIdentityHandler answers `git.identity.ensure` and `git.identity.remove`: the public half of
// the key this station pushes with, generating the pair on first ask, and deleting it on withdrawal.
//
// **The hub asks; the node never volunteers.** Most stations never touch git, and giving every
// adopted station a forge account would create accounts nobody uses and keys nobody revokes. So
// this is explicit: an operator provisions the stations that need it, and the hub calls here.
//
// Removal matters as much as creation, and not only for tidiness: `EnsureKey` is idempotent, so a
// leftover key file would be handed back after a station was reassigned to a different agent — and
// registered against that agent's account. One key, two identities.
//
// The private half stays on this node, in its config directory — see `internal/gitidentity` for
// why not the workspace. Nothing in this exchange carries a secret: the hub receives a public key
// and registers it, and holds no credential of the station's own.
type gitIdentityHandler struct {
	inner Handler
	// root is the node's config directory. Injected rather than resolved here so a test can
	// write somewhere disposable.
	root string
}

// NewGitIdentityHandler wraps inner with the git identity verb.
func NewGitIdentityHandler(inner Handler, root string) Handler {
	return &gitIdentityHandler{inner: inner, root: root}
}

func (h *gitIdentityHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	switch verb {
	case "git.identity.ensure", "git.identity.remove":
	default:
		return h.inner.Handle(ctx, verb, params, emit)
	}

	var p struct {
		StationID string `json:"stationId"`
		// The name the node knows this station by, supplied because the node cannot derive it: ids
		// are the hub's. Recorded beside the key so the spawn path can find it. See
		// `gitidentity.stationFile`.
		StationKey string `json:"stationKey"`
		// Who this station's commits are by. Absent from an older hub, and from nothing else: an
		// ensure without it leaves a recorded author alone rather than erasing it.
		Author *gitidentity.Author `json:"author,omitempty"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("%s: bad params: %w", verb, err)
	}
	if p.StationID == "" {
		return nil, false, fmt.Errorf("%s: missing stationId", verb)
	}

	if verb == "git.identity.remove" {
		if err := gitidentity.Remove(h.root, p.StationID); err != nil {
			return nil, false, fmt.Errorf("git.identity.remove: %w", err)
		}
		return map[string]any{"removed": true}, false, nil
	}

	if p.StationKey == "" {
		// Refused rather than defaulted: a key with no station key is a key the spawn path will
		// never find, so the push it was provisioned for would fail with nothing to explain it.
		return nil, false, fmt.Errorf("git.identity.ensure: missing stationKey")
	}

	pub, _, created, err := gitidentity.EnsureKey(h.root, p.StationID, p.StationKey)
	if err != nil {
		return nil, false, fmt.Errorf("git.identity.ensure: %w", err)
	}
	if p.Author != nil {
		// After the key, because an author is recorded only beside a key that exists.
		if err := gitidentity.RecordAuthor(h.root, p.StationID, *p.Author); err != nil {
			return nil, false, fmt.Errorf("git.identity.ensure: %w", err)
		}
	}

	// The path is deliberately not returned. The hub has no use for it and a path in a hub log is
	// a map to the one file on this node worth stealing.
	return map[string]any{"publicKey": pub, "created": created}, false, nil
}

// HandleFrame forwards, as every wrapping handler must: the dispatcher checks the OUTERMOST
// handler for FrameHandler, so omitting this makes a terminal attach succeed and then silently
// drop every keystroke.
func (h *gitIdentityHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
