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
	case "work-decisions", "work-completion", "work-status":
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
