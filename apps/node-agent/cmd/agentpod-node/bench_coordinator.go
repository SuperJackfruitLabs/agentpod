package main

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchbridge"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

// coordinatorSlot holds the dedicated coordinator built from the installed registry. A registry
// write from the hub (`bench.registry.set|remove`) rebuilds it in place, so a changed stage is
// served with no node restart, and a registry that was broken at start (an empty or stale file)
// starts serving once a write makes it valid. A request already running keeps the handler it
// started with; that handler re-reads the file before every effect and stops at the first change.
type coordinatorSlot struct {
	cfg config.Config

	mu        sync.RWMutex
	dedicated *benchbridge.Handler
	err       error
}

func newCoordinatorSlot(cfg config.Config) *coordinatorSlot {
	s := &coordinatorSlot{cfg: cfg}
	s.reload()
	return s
}

func (s *coordinatorSlot) reload() {
	next, err := benchbridge.NewHandler(s.cfg.ProposedCheckpointRegistry, s.cfg.Hub, s.cfg.NodeID, s.cfg.NodeSecret)
	s.mu.Lock()
	previous := s.dedicated
	s.dedicated, s.err = next, err
	s.mu.Unlock()
	if previous != nil {
		// Closes idle connections only; a request in flight on it finishes.
		previous.Close()
	}
}

func (s *coordinatorSlot) current() (*benchbridge.Handler, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.dedicated, s.err
}

func (s *coordinatorSlot) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dedicated != nil {
		s.dedicated.Close()
		s.dedicated = nil
	}
}

// No coordinator capability is advertised. Only explicit operator configuration installs
// this proposed branch; a broken pin refuses dedicated work without ACP fallback. The registry
// verbs are always answered, so the hub can tell a node with no registry from an older node.
func checkpointCoordinatorHandler(next gateway.Handler, cfg config.Config) (gateway.Handler, func()) {
	var slot *coordinatorSlot
	if cfg.ProposedCheckpointRegistry != "" {
		slot = newCoordinatorSlot(cfg)
	}
	manager := &benchbridge.RegistryManager{Path: cfg.ProposedCheckpointRegistry, NodeID: cfg.NodeID}
	if slot != nil {
		manager.Reload = slot.reload
	}
	closeAll := func() {
		if slot != nil {
			slot.close()
		}
	}
	return &coordinatorHandler{next: next, slot: slot, manager: manager}, closeAll
}

// coordinatorHandler wraps the chain. It is a type, not a gateway.HandlerFunc, because a wrapper
// must forward HandleFrame: ACP and terminal input arrive as frames, and a wrapper that drops
// gateway.FrameHandler leaves every ACP session waiting for its handshake.
type coordinatorHandler struct {
	next    gateway.Handler
	slot    *coordinatorSlot
	manager *benchbridge.RegistryManager
}

func (h *coordinatorHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.next.(gateway.FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}

func (h *coordinatorHandler) Handle(ctx context.Context, verb string, params json.RawMessage, emit func(int, string, bool, string) error) (any, bool, error) {
	slot, next := h.slot, h.next
	switch verb {
	case benchbridge.VerbRegistryStatus, benchbridge.VerbRegistrySet, benchbridge.VerbRegistryRemove:
		value, err := registryVerb(ctx, h.manager, verb, params)
		return value, false, err
	case benchcoordinatorwire.Verb:
		if slot == nil {
			// Unchanged from before the registry verbs: with no registry pinned the
			// coordinator verb is not this branch's.
			return next.Handle(ctx, verb, params, emit)
		}
	default:
		return next.Handle(ctx, verb, params, emit)
	}
	dedicated, err := slot.current()
	if err != nil || dedicated == nil {
		request, parseErr := benchcoordinatorwire.ParseRequest(params)
		if parseErr != nil {
			return nil, false, benchcoordinatorwire.ErrInvalid
		}
		return benchcoordinatorwire.Response{Version: benchcoordinatorwire.Version, Operation: request.Operation, State: "refused", Code: "unavailable"}, false, nil
	}
	return dedicated.Handle(ctx, verb, params, emit)
}

func strictDecode(raw json.RawMessage, dst any) error {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	return d.Decode(dst)
}

func registryVerb(ctx context.Context, manager *benchbridge.RegistryManager, verb string, params json.RawMessage) (any, error) {
	switch verb {
	case benchbridge.VerbRegistrySet:
		var req benchbridge.SetRequest
		if err := strictDecode(params, &req); err != nil {
			return nil, &benchbridge.Refusal{Code: "invalid_request", Message: "not a registry change"}
		}
		return manager.Set(ctx, req)
	case benchbridge.VerbRegistryRemove:
		var req benchbridge.RemoveRequest
		if err := strictDecode(params, &req); err != nil || req.ID == "" {
			return nil, &benchbridge.Refusal{Code: "invalid_request", Message: "a removal names a profile id"}
		}
		return manager.Remove(ctx, req)
	default:
		return manager.Status(ctx), nil
	}
}
