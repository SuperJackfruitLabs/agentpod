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
	if verb == "salaam.work-capability" {
		var p struct {
			NodeID    string `json:"node_id"`
			Workspace string `json:"workspace"`
			Key       string `json:"station_key"`
		}
		d := json.NewDecoder(strings.NewReader(string(params)))
		d.DisallowUnknownFields()
		if err := d.Decode(&p); err != nil {
			return nil, false, fmt.Errorf("salaam: invalid capability probe")
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing capability probe")
		}
		result, err := h.client.WorkCapability(ctx, p.NodeID, p.Workspace, p.Key)
		return result, false, err
	}
	if verb == "salaam.work-expire" {
		var p salaam.WorkExpiry
		d := json.NewDecoder(strings.NewReader(string(params)))
		d.DisallowUnknownFields()
		if err := d.Decode(&p); err != nil {
			return nil, false, fmt.Errorf("salaam: invalid settlement")
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing settlement")
		}
		owner, err := h.client.Request(ctx, "status", p.Binding, "work-expirement-owner", 0, "")
		if err != nil {
			return nil, false, err
		}
		result, err := h.client.ExpireWork(ctx, p, owner)
		return result, false, err
	}
	if verb == "salaam.work-fail" {
		var p salaam.WorkSettlement
		d := json.NewDecoder(strings.NewReader(string(params)))
		d.DisallowUnknownFields()
		if err := d.Decode(&p); err != nil {
			return nil, false, fmt.Errorf("salaam: invalid settlement")
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing settlement")
		}
		owner, err := h.client.Request(ctx, "status", p.Binding, "work-settlement-owner", 0, "")
		if err != nil {
			return nil, false, err
		}
		result, err := h.client.FailWork(ctx, p, owner)
		return result, false, err
	}
	if verb == "salaam.work-settle" {
		var p salaam.WorkSettlement
		d := json.NewDecoder(strings.NewReader(string(params)))
		d.DisallowUnknownFields()
		if err := d.Decode(&p); err != nil {
			return nil, false, fmt.Errorf("salaam: invalid settlement")
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing settlement")
		}
		owner, err := h.client.Request(ctx, "status", p.Binding, "work-settlement-owner", 0, "")
		if err != nil {
			return nil, false, err
		}
		result, err := h.client.SettleWork(ctx, p, owner)
		return result, false, err
	}
	if verb == "salaam.work-abandon" {
		var p salaam.WorkSettlement
		d := json.NewDecoder(strings.NewReader(string(params)))
		d.DisallowUnknownFields()
		if err := d.Decode(&p); err != nil {
			return nil, false, fmt.Errorf("salaam: invalid settlement")
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing settlement")
		}
		owner, err := h.client.Request(ctx, "status", p.Binding, "work-settlement-owner", 0, "")
		if err != nil {
			return nil, false, err
		}
		result, err := h.client.AbandonWork(ctx, p, owner)
		return result, false, err
	}
	if verb == "salaam.work-progress" {
		var p salaam.WorkProgress
		d := json.NewDecoder(strings.NewReader(string(params)))
		d.DisallowUnknownFields()
		if err := d.Decode(&p); err != nil {
			return nil, false, fmt.Errorf("salaam: invalid progression")
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing progression")
		}
		owner, err := h.client.Request(ctx, "status", p.Binding, "work-progression-owner", 0, "")
		if err != nil {
			return nil, false, err
		}
		result, err := h.client.ProgressWork(ctx, p, owner)
		return result, false, err
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
	if verb == "salaam.work-evidence-artifacts" {
		var input struct {
			Binding     salaam.Binding `json:"binding"`
			ArtifactIDs []string       `json:"artifact_ids"`
		}
		decoder := json.NewDecoder(strings.NewReader(string(params)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			return nil, false, fmt.Errorf("salaam: malformed artifact selection")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing artifact selection")
		}
		result, err := h.client.WorkEvidenceArtifacts(ctx, input.Binding, input.ArtifactIDs)
		return result, false, err
	}
	if verb == "salaam.work-trace" {
		var input struct {
			Binding     salaam.Binding `json:"binding"`
			Traceparent string         `json:"traceparent"`
		}
		decoder := json.NewDecoder(strings.NewReader(string(params)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			return nil, false, fmt.Errorf("salaam: malformed work trace")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing work trace")
		}
		result, err := h.client.WorkTrace(ctx, input.Binding, input.Traceparent)
		return result, false, err
	}
	if verb == "salaam.work-evidence" || verb == "salaam.work-decisions" || verb == "salaam.work-decision" || verb == "salaam.work-completion" || verb == "salaam.work-status" {
		var work struct {
			Binding salaam.Binding  `json:"binding"`
			Answer  json.RawMessage `json:"answer"`
		}
		decoder := json.NewDecoder(strings.NewReader(string(params)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&work); err != nil {
			return nil, false, fmt.Errorf("salaam: malformed decision control")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return nil, false, fmt.Errorf("salaam: trailing decision control")
		}
		owner, err := h.client.Request(ctx, "status", work.Binding, "work-decision-owner", 0, "")
		if err != nil {
			return nil, false, err
		}
		result, err := h.client.WorkControl(ctx, strings.TrimPrefix(verb, "salaam."), work.Binding, work.Answer, owner)
		return result, false, err
	}
	var p struct {
		Binding       salaam.Binding `json:"binding"`
		RequestID     string         `json:"request_id"`
		LeaseSequence int64          `json:"lease_sequence"`
		Reason        string         `json:"reason"`
		// Admit only: the hub session whose conversation a resume continues (Salaam checks it).
		ContinueFrom string `json:"continue_from"`
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
	if p.ContinueFrom != "" && action != "admit" {
		return nil, false, fmt.Errorf("salaam: only an admission can continue a conversation")
	}
	if p.ContinueFrom != "" {
		result, err := h.client.AdmitContinuing(ctx, p.Binding, p.RequestID, p.ContinueFrom)
		return result, false, err
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
