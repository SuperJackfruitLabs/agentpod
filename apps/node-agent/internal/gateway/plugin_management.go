package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
)

// PluginManagementDeps wires the Console's plugin operations (#553). The node
// resolves the profile from a detected station key, and asks Hermes its version
// itself: nothing the hub sends names a path or vouches for a version.
type PluginManagementDeps struct {
	NodeID     string
	ProfileDir func(context.Context, string) (string, error)
	Gate       func(context.Context) hermeslive.Gate
	Now        func() time.Time
}

type PluginOperationResult struct {
	Receipt *hermeslive.OperationReceipt `json:"receipt"`
}

type pluginManagementHandler struct {
	inner Handler
	deps  PluginManagementDeps
}

func NewPluginManagementHandler(inner Handler, deps PluginManagementDeps) Handler {
	return &pluginManagementHandler{inner: inner, deps: deps}
}

// pluginManagementParams decodes the flat protocol strictly, as
// skillManagementParams does: exact keys, no duplicates, nothing trailing.
func pluginManagementParams(verb string, raw json.RawMessage) (map[string]string, error) {
	fields := map[string]bool{"key": true, "plugin": true, "operationId": true}
	switch verb {
	case "plugins.plan":
		fields["action"] = true
	case "plugins.apply":
		fields["expectedPlanDigest"] = true
	}
	invalid := fmt.Errorf("plugins: invalid management params")
	if len(raw) > 4096 {
		return nil, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, invalid
	}
	params := map[string]string{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, invalid
		}
		key, ok := token.(string)
		if !ok || !fields[key] {
			return nil, invalid
		}
		if _, exists := params[key]; exists {
			return nil, invalid
		}
		var value string
		if err := decoder.Decode(&value); err != nil {
			return nil, invalid
		}
		params[key] = value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || decoder.Decode(new(any)) != io.EOF || len(params) != len(fields) {
		return nil, invalid
	}
	if !validArtifactStationKey(params["key"]) || params["plugin"] != hermeslive.Name || !artifactOperation.MatchString(params["operationId"]) {
		return nil, invalid
	}
	if fields["action"] && params["action"] != "enable" && params["action"] != "disable" {
		return nil, invalid
	}
	if fields["expectedPlanDigest"] && !artifactDigest.MatchString(params["expectedPlanDigest"]) {
		return nil, invalid
	}
	return params, nil
}

func (h *pluginManagementHandler) Handle(ctx context.Context, verb string, raw json.RawMessage, emit func(int, string, bool, string) error) (any, bool, error) {
	switch verb {
	case "plugins.plan", "plugins.apply", "plugins.operation":
	default:
		return h.inner.Handle(ctx, verb, raw, emit)
	}
	params, err := pluginManagementParams(verb, raw)
	if err != nil {
		return nil, false, err
	}
	if h.deps.NodeID == "" || h.deps.ProfileDir == nil || h.deps.Gate == nil {
		return nil, false, fmt.Errorf("plugins: management unavailable")
	}
	dir, err := h.deps.ProfileDir(ctx, params["key"])
	if err != nil {
		return nil, false, err
	}
	now := h.deps.Now
	if now == nil {
		now = time.Now
	}
	operator := hermeslive.Operator{
		ProfileDir: dir,
		Binding:    hermeslive.OperationBinding{NodeID: h.deps.NodeID, StationKey: params["key"], Harness: "hermes", Plugin: params["plugin"]},
		Gate:       func() hermeslive.Gate { return h.deps.Gate(ctx) },
		Now:        now,
	}
	switch verb {
	case "plugins.plan":
		plan, err := operator.Plan(params["operationId"], params["action"])
		return plan, false, err
	case "plugins.apply":
		receipt, err := operator.Apply(params["operationId"], params["expectedPlanDigest"])
		return receipt, false, err
	default:
		receipt, err := operator.Inspect(params["operationId"])
		if errors.Is(err, hermeslive.ErrOperationNotFound) {
			return PluginOperationResult{}, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		return PluginOperationResult{Receipt: &receipt}, false, nil
	}
}

func (h *pluginManagementHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if handler, ok := h.inner.(FrameHandler); ok {
		return handler.HandleFrame(frameType, id, raw)
	}
	return nil
}
