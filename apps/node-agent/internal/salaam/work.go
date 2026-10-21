package salaam

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
)

// WorkPayload is private node control input, never ACP/model metadata. Payload
// bytes are independently parsed and digested by the daemon. No runtime advertises
// this incomplete capability. The authenticated gateway routes private control only.
type WorkIdentity struct {
	BoardID     string `json:"board_id"`
	CardID      string `json:"card_id"`
	StageKey    string `json:"stage_key"`
	InputDigest string `json:"input_digest"`
	PlanDigest  string `json:"plan_digest"`
}
type WorkAdmission struct {
	Version   int          `json:"version"`
	RequestID string       `json:"request_id"`
	Binding   Binding      `json:"binding"`
	Work      WorkIdentity `json:"work"`
}
type WorkPayload struct {
	Admission WorkAdmission   `json:"admission"`
	Input     json.RawMessage `json:"input"`
	Plan      json.RawMessage `json:"plan"`
}
type WorkReceipt struct {
	Version       int    `json:"version"`
	State         string `json:"state"`
	SessionID     string `json:"session_id"`
	TaskID        string `json:"task_id"`
	RequestID     string `json:"request_id"`
	BindingDigest string `json:"binding_digest"`
	PlanRevision  int    `json:"plan_revision"`
}

// WorkAdmit needs an independently obtained authority receipt from Request(status).
// It does not renew a lease or retry under another run after an uncertain reply.
func (c *Client) WorkAdmit(ctx context.Context, payload WorkPayload, owner Status) (WorkReceipt, error) {
	var out WorkReceipt
	a := payload.Admission
	if err := c.validate(a.Binding); err != nil {
		return out, err
	}
	if a.Version != 1 || a.Binding.Run.Source != "superpipeline" || owner.Binding != a.Binding || owner.SessionID == "" || owner.AdmissionID == "" ||
		!regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(owner.BindingDigest) ||
		!regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(a.RequestID) || !json.Valid(payload.Input) || !json.Valid(payload.Plan) ||
		len(payload.Input) > 512*1024 || len(payload.Plan) > 256*1024 {
		return out, fmt.Errorf("salaam: invalid private work binding or payload")
	}
	if err := c.call(ctx, "work-admit", payload, &out); err != nil {
		return WorkReceipt{}, err
	}
	if out.Version != 1 || out.State != "admitted" || out.SessionID != owner.SessionID || out.RequestID != a.RequestID ||
		out.BindingDigest != owner.BindingDigest || out.TaskID == "" || out.PlanRevision != 1 {
		return WorkReceipt{}, fmt.Errorf("salaam: work receipt does not match admitted authority")
	}
	return out, nil
}

// WorkControl forwards only the closed private decision and completion verbs. The daemon
// owns operation validation; no ACP permission or model metadata enters here.
func (c *Client) WorkControl(ctx context.Context, action string, binding Binding, answer json.RawMessage, owner Status) (json.RawMessage, error) {
	if err := c.validate(binding); err != nil {
		return nil, err
	}
	if owner.Binding != binding || owner.SessionID == "" || binding.Run.Source != "superpipeline" {
		return nil, fmt.Errorf("salaam: private decision owner mismatch")
	}
	body := map[string]any{"binding": binding}
	switch action {
	case "work-evidence", "work-decisions", "work-completion", "work-status":
		if len(answer) != 0 {
			return nil, fmt.Errorf("salaam: discovery cannot carry an answer")
		}
	case "work-decision":
		if !json.Valid(answer) || len(answer) > 64*1024 {
			return nil, fmt.Errorf("salaam: invalid bounded decision answer")
		}
		body["answer"] = answer
	default:
		return nil, fmt.Errorf("salaam: unsupported work decision action")
	}
	if action == "work-evidence" {
		body["schema_version"] = "salaam-execution-evidence/v1"
	}
	var out json.RawMessage
	if err := c.call(ctx, action, body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// WorkCapability is a fresh private observation, never cached inventory/model metadata.
func (c *Client) WorkCapability(ctx context.Context, node, workspace, key string) (any, error) {
	if node != c.NodeID || workspace != c.Workspace || key != StationKey(c.Workspace) || node == "" {
		return nil, fmt.Errorf("salaam: capability probe names another station")
	}
	if c.Runtime == nil {
		return nil, fmt.Errorf("salaam: reviewed strict work host required")
	}
	if err := c.Runtime.ensureStrict(ctx); err != nil {
		return nil, err
	}
	var result struct {
		Version int  `json:"version"`
		Enabled bool `json:"enabled"`
	}
	if err := c.call(ctx, "work-capability", map[string]any{}, &result); err != nil {
		return nil, err
	}
	if result.Version != 1 || !result.Enabled {
		return nil, fmt.Errorf("salaam: strict work capability unavailable")
	}
	return result, nil
}

// WorkProgress forwards one bounded, original-run progression request.
type WorkProgress struct {
	Binding       Binding `json:"binding"`
	RequestID     string  `json:"request_id"`
	WorkRequestID string  `json:"work_request_id"`
	MaxSteps      int     `json:"max_steps"`
	Compact       bool    `json:"compact"`
}

func (c *Client) ProgressWork(ctx context.Context, p WorkProgress, owner Status) (json.RawMessage, error) {
	if err := c.validate(p.Binding); err != nil {
		return nil, err
	}
	uuid := regexp.MustCompile(`^[a-f0-9-]{36}$`)
	if owner.Binding != p.Binding || owner.SessionID == "" || p.Binding.Run.Source != "superpipeline" || !uuid.MatchString(p.RequestID) || p.RequestID != p.WorkRequestID || p.MaxSteps < 1 || p.MaxSteps > 32 || p.Compact {
		return nil, fmt.Errorf("salaam: invalid bounded work progression")
	}
	var out json.RawMessage
	if err := c.call(ctx, "work-progress", p, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// WorkSettle is explicit terminal recovery, never an execution or permission grant.
type WorkSettlement struct {
	Binding                Binding `json:"binding"`
	RequestID              string  `json:"request_id"`
	WorkRequestID          string  `json:"work_request_id"`
	ProducerTerminalDigest string  `json:"producer_terminal_digest"`
}

func (c *Client) SettleWork(ctx context.Context, p WorkSettlement, owner Status) (json.RawMessage, error) {
	if err := c.validate(p.Binding); err != nil {
		return nil, err
	}
	if owner.Binding != p.Binding || owner.BindingDigest != canonicalDigest(p.Binding) || owner.SessionID == "" || p.Binding.Run.Source != "superpipeline" || owner.Authorized || !owner.Revoked || !owner.OwnedExecutionStopped || len(owner.UnresolvedOperations) > 0 || len(owner.ActiveAttempts) > 0 || len(owner.InterruptedAttempts) > 0 || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(p.RequestID) || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(p.WorkRequestID) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(p.ProducerTerminalDigest) {
		return nil, fmt.Errorf("salaam: terminal settlement owner or stop proof refused")
	}
	var out json.RawMessage
	if err := c.call(ctx, "work-settle", p, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ExpireWork settles only a daemon-proven expired unapplied approval.
type WorkExpiry struct {
	WorkSettlement
	DecisionRequestID string `json:"decision_request_id"`
}

func (c *Client) ExpireWork(ctx context.Context, p WorkExpiry, owner Status) (json.RawMessage, error) {
	if err := c.validate(p.Binding); err != nil {
		return nil, err
	}
	if owner.Binding != p.Binding || owner.BindingDigest != canonicalDigest(p.Binding) || owner.SessionID == "" || p.Binding.Run.Source != "superpipeline" || owner.Authorized || !owner.Revoked || !owner.OwnedExecutionStopped || len(owner.UnresolvedOperations) > 0 || len(owner.ActiveAttempts) > 0 || len(owner.InterruptedAttempts) > 0 || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(p.RequestID) || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(p.WorkRequestID) || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(p.DecisionRequestID) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(p.ProducerTerminalDigest) {
		return nil, fmt.Errorf("salaam: expired approval owner or stop proof refused")
	}
	var out json.RawMessage
	if err := c.call(ctx, "work-expire", p, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// FailWork preserves interrupted history; only the daemon may attest known effects.
func (c *Client) FailWork(ctx context.Context, p WorkSettlement, owner Status) (json.RawMessage, error) {
	if err := c.validate(p.Binding); err != nil {
		return nil, err
	}
	if owner.Binding != p.Binding || owner.BindingDigest != canonicalDigest(p.Binding) || owner.SessionID == "" || p.Binding.Run.Source != "superpipeline" || owner.Authorized || !owner.Revoked || !owner.OwnedExecutionStopped || len(owner.UnresolvedOperations) > 0 || len(owner.ActiveAttempts) > 0 || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(p.RequestID) || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(p.WorkRequestID) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(p.ProducerTerminalDigest) {
		return nil, fmt.Errorf("salaam: known-effect failure owner or stop proof refused")
	}
	var out json.RawMessage
	if err := c.call(ctx, "work-fail", p, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AbandonWork preserves local success as historical evidence, never producer success.
func (c *Client) AbandonWork(ctx context.Context, p WorkSettlement, owner Status) (json.RawMessage, error) {
	if err := c.validate(p.Binding); err != nil {
		return nil, err
	}
	if owner.Binding != p.Binding || owner.BindingDigest != canonicalDigest(p.Binding) || owner.SessionID == "" || p.Binding.Run.Source != "superpipeline" || owner.Authorized || !owner.Revoked || !owner.OwnedExecutionStopped || len(owner.UnresolvedOperations) > 0 || len(owner.ActiveAttempts) > 0 || len(owner.InterruptedAttempts) > 0 || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(p.RequestID) || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(p.WorkRequestID) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(p.ProducerTerminalDigest) {
		return nil, fmt.Errorf("salaam: terminal settlement owner or stop proof refused")
	}
	var out json.RawMessage
	if err := c.call(ctx, "work-abandon", p, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// WorkTrace stores optional correlation against an already admitted work root.
// This call never admits, renews, or grants execution authority.
func (c *Client) WorkTrace(ctx context.Context, binding Binding, traceparent string) (json.RawMessage, error) {
	if err := c.validate(binding); err != nil {
		return nil, err
	}
	valid := regexp.MustCompile(`^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$`)
	if !valid.MatchString(traceparent) || traceparent[3:35] == "00000000000000000000000000000000" || traceparent[36:52] == "0000000000000000" || binding.Run.Source != "superpipeline" {
		return nil, fmt.Errorf("salaam: invalid work trace")
	}
	var out json.RawMessage
	err := c.call(ctx, "work-trace", map[string]any{"schema_version": "salaam-work-trace/v1", "binding": binding, "traceparent": traceparent}, &out)
	return out, err
}

// WorkEvidenceArtifacts reads only explicitly selected immutable historical artifacts.
func (c *Client) WorkEvidenceArtifacts(ctx context.Context, binding Binding, ids []string) (json.RawMessage, error) {
	if err := c.validate(binding); err != nil {
		return nil, err
	}
	if len(ids) < 1 || len(ids) > 16 || binding.Run.Source != "superpipeline" {
		return nil, fmt.Errorf("salaam: invalid artifact selection")
	}
	seen := map[string]bool{}
	valid := regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
	for _, id := range ids {
		if !valid.MatchString(id) || seen[id] {
			return nil, fmt.Errorf("salaam: invalid artifact identity")
		}
		seen[id] = true
	}
	var out json.RawMessage
	err := c.call(ctx, "work-evidence-artifacts", map[string]any{"schema_version": "salaam-execution-artifacts/v1", "binding": binding, "artifact_ids": ids}, &out)
	return out, err
}
