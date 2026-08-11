package gateway

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gitops"
)

// changesetHandler wraps an inner Handler and adds the two changeset verbs.
//
// Neither streams: both return a bounded result, so they take the plain
// request/response path rather than the stream frames term.attach uses.
type changesetHandler struct {
	inner    Handler
	resolver WorkspaceResolver
}

// NewChangesetHandler wraps inner with changeset.status and changeset.diff.
func NewChangesetHandler(inner Handler, resolver WorkspaceResolver) Handler {
	return &changesetHandler{inner: inner, resolver: resolver}
}

func (h *changesetHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	switch verb {
	case "changeset.status":
		return h.status(ctx, params)
	case "changeset.diff":
		return h.diff(ctx, params)
	default:
		return h.inner.Handle(ctx, verb, params, emit)
	}
}

func (h *changesetHandler) workspace(key string) (string, error) {
	if key == "" {
		return "", fmt.Errorf("changeset: missing key")
	}
	dir, err := h.resolver.Workspace(key)
	if err != nil {
		return "", fmt.Errorf("changeset: workspace for %q: %w", key, err)
	}
	return dir, nil
}

func (h *changesetHandler) status(ctx context.Context, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key  string `json:"key"`
		Base string `json:"base"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("changeset.status: bad params: %w", err)
	}
	dir, err := h.workspace(p.Key)
	if err != nil {
		return nil, false, err
	}
	st, err := gitops.GetStatus(ctx, dir, p.Base)
	if err != nil {
		return nil, false, fmt.Errorf("changeset.status: %w", err)
	}
	return st, false, nil
}

func (h *changesetHandler) diff(ctx context.Context, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key      string `json:"key"`
		Base     string `json:"base"`
		Path     string `json:"path"`
		Side     string `json:"side"`
		MaxBytes int    `json:"maxBytes"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("changeset.diff: bad params: %w", err)
	}
	if p.Side == "" {
		return nil, false, fmt.Errorf("changeset.diff: missing side (uncommitted or committed)")
	}
	dir, err := h.workspace(p.Key)
	if err != nil {
		return nil, false, err
	}
	d, err := gitops.GetDiff(ctx, dir, p.Side, p.Path, p.Base, p.MaxBytes)
	if err != nil {
		return nil, false, fmt.Errorf("changeset.diff: %w", err)
	}
	return d, false, nil
}
