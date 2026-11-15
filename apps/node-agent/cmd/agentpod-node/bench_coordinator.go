package main

import (
	"context"
	"encoding/json"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchbridge"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

// No capability is advertised. Only explicit operator configuration installs
// this proposed branch; a broken pin refuses dedicated work without ACP fallback.
func checkpointCoordinatorHandler(next gateway.Handler, cfg config.Config) (gateway.Handler, func()) {
	if cfg.ProposedCheckpointRegistry == "" {
		return next, func() {}
	}
	dedicated, err := benchbridge.NewHandler(cfg.ProposedCheckpointRegistry, cfg.Hub, cfg.NodeID, cfg.NodeSecret)
	close := func() {}
	if err == nil {
		close = dedicated.Close
	}
	return gateway.HandlerFunc(func(ctx context.Context, verb string, params json.RawMessage, emit func(int, string, bool, string) error) (any, bool, error) {
		if verb != benchcoordinatorwire.Verb {
			return next.Handle(ctx, verb, params, emit)
		}
		if err != nil {
			request, parseErr := benchcoordinatorwire.ParseRequest(params)
			if parseErr != nil {
				return nil, false, benchcoordinatorwire.ErrInvalid
			}
			return benchcoordinatorwire.Response{Version: benchcoordinatorwire.Version, Operation: request.Operation, State: "refused", Code: "unavailable"}, false, nil
		}
		return dedicated.Handle(ctx, verb, params, emit)
	}), close
}
