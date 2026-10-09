package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// ManagedMCPProxy is the running loopback MCP proxy as the management verbs see it
// (mcpproxy.Proxy).
type ManagedMCPProxy interface {
	Stations() []string
	SetStations(ids []string) error
	Rotate(ids []string) ([]string, error)
}

// mcpProxyManageHandler answers `mcp.proxy.status`, `mcp.proxy.set` and `mcp.proxy.rotate`: which
// stations the node's loopback MCP proxy serves, changing that without a restart, and new secrets.
//
// Station ids go in and come out; a secret never does. The secrets live in the proxy's own
// owner-only state file and nowhere else.
type mcpProxyManageHandler struct {
	inner   Handler
	proxy   ManagedMCPProxy
	persist func(stations []string) error
}

// NewMCPProxyManageHandler wraps inner with the proxy management verbs. persist writes the new
// station list to the node's config (`mcpProxy.stations`) so it survives a restart.
func NewMCPProxyManageHandler(inner Handler, proxy ManagedMCPProxy, persist func([]string) error) Handler {
	return &mcpProxyManageHandler{inner: inner, proxy: proxy, persist: persist}
}

func (h *mcpProxyManageHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	switch verb {
	case "mcp.proxy.status":
		return map[string]any{"running": true, "stations": nonNil(h.proxy.Stations())}, false, nil
	case "mcp.proxy.set":
		var p struct {
			Enable  []string `json:"enable"`
			Disable []string `json:"disable"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, false, fmt.Errorf("mcp.proxy.set: bad params: %w", err)
		}
		for _, id := range append(append([]string{}, p.Enable...), p.Disable...) {
			if id == "" || strings.ContainsAny(id, "/?#") {
				return nil, false, fmt.Errorf("mcp.proxy.set: %q is not a station id", id)
			}
		}
		drop := map[string]bool{}
		for _, id := range p.Disable {
			drop[id] = true
		}
		seen := map[string]bool{}
		next := []string{}
		for _, id := range append(h.proxy.Stations(), p.Enable...) {
			if drop[id] || seen[id] {
				continue
			}
			seen[id] = true
			next = append(next, id)
		}
		// Config first: a station served but not in the config would vanish at the next restart.
		if err := h.persist(next); err != nil {
			return nil, false, fmt.Errorf("mcp.proxy.set: writing the node config: %w", err)
		}
		if err := h.proxy.SetStations(next); err != nil {
			return nil, false, fmt.Errorf("mcp.proxy.set: %w", err)
		}
		return map[string]any{"stations": nonNil(h.proxy.Stations())}, false, nil
	case "mcp.proxy.rotate":
		var p struct {
			Stations []string `json:"stations"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, false, fmt.Errorf("mcp.proxy.rotate: bad params: %w", err)
		}
		rotated, err := h.proxy.Rotate(p.Stations)
		if err != nil {
			return nil, false, fmt.Errorf("mcp.proxy.rotate: %w", err)
		}
		return map[string]any{"rotated": nonNil(rotated)}, false, nil
	}
	return h.inner.Handle(ctx, verb, params, emit)
}

// HandleFrame forwards, as every wrapping handler must (see gitIdentityHandler.HandleFrame).
func (h *mcpProxyManageHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
