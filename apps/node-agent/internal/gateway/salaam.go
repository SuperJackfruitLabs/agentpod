package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
	"strings"
)

type salaamHandler struct {
	inner  Handler
	client *salaam.Client
}

func NewSalaamHandler(inner Handler, client *salaam.Client) Handler {
	if acp, ok := inner.(*acpHandler); ok {
		acp.salaam = client
	}
	return &salaamHandler{inner, client}
}
func (h *salaamHandler) Handle(ctx context.Context, verb string, params json.RawMessage, emit func(int, string, bool, string) error) (any, bool, error) {
	if !strings.HasPrefix(verb, "salaam.") {
		return h.inner.Handle(ctx, verb, params, emit)
	}
	if h.client == nil {
		return nil, false, fmt.Errorf("salaam: node authority control is not configured")
	}
	var p struct {
		Binding       salaam.Binding `json:"binding"`
		RequestID     string         `json:"request_id"`
		LeaseSequence int64          `json:"lease_sequence"`
		Reason        string         `json:"reason"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(params)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&p); err != nil {
		return nil, false, fmt.Errorf("salaam: malformed authority parameters")
	}
	action := strings.TrimPrefix(verb, "salaam.")
	if p.RequestID == "" || (action == "renew" && p.LeaseSequence < 1) || (action == "revoke" && (p.Reason == "" || len(p.Reason) > 1024)) {
		return nil, false, fmt.Errorf("salaam: missing authority request identity")
	}
	result, err := h.client.Request(ctx, action, p.Binding, p.RequestID, p.LeaseSequence, p.Reason)
	return result, false, err
}
func (h *salaamHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if next, ok := h.inner.(FrameHandler); ok {
		return next.HandleFrame(frameType, id, raw)
	}
	return nil
}
