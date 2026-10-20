package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
	"io"
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
	if verb == "salaam.work-admit" {
		var work salaam.WorkPayload
		decoder := json.NewDecoder(strings.NewReader(string(params)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&work); err != nil {
			return nil, false, fmt.Errorf("salaam: malformed private work payload")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing private work payload")
		}
		owner, err := h.client.Request(ctx, "status", work.Admission.Binding, "work-owner:"+work.Admission.RequestID, 0, "")
		if err != nil {
			return nil, false, err
		}
		result, err := h.client.WorkAdmit(ctx, work, owner)
		return result, false, err
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
