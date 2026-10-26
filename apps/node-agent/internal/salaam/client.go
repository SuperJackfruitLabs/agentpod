// Package salaam is the node-owned control path to the private Salaam daemon.
// ACP metadata cannot create an admission. No control credential leaves the node.
package salaam

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"time"
)

type Run struct {
	Source string `json:"source"`
	ID     string `json:"id"`
	Epoch  int64  `json:"epoch"`
}
type Binding struct {
	Version        int    `json:"version"`
	OrganizationID string `json:"organization_id"`
	PrincipalID    string `json:"principal_id"`
	NodeID         string `json:"node_id"`
	StationID      string `json:"station_id"`
	StationKey     string `json:"station_key"`
	OccupancyEpoch int64  `json:"occupancy_epoch"`
	HubSessionID   string `json:"hub_session_id"`
	Workspace      string `json:"workspace"`
	Run            Run    `json:"run"`
}

func (b *Binding) UnmarshalJSON(data []byte) error {
	type plain Binding
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	return d.Decode((*plain)(b))
}

type Status struct {
	AdmissionID           string   `json:"admission_id"`
	SessionID             string   `json:"session_id"`
	Binding               Binding  `json:"binding"`
	BindingDigest         string   `json:"binding_digest"`
	LeaseSequence         int64    `json:"lease_sequence"`
	ExpiresAt             int64    `json:"expires_at"`
	Authorized            bool     `json:"authorized"`
	Revoked               bool     `json:"revoked"`
	OwnedExecutionStopped bool     `json:"owned_execution_stopped"`
	UnresolvedOperations  []string `json:"unresolved_operations"`
	ActiveAttempts        []string `json:"active_attempts"`
	InterruptedAttempts   []string `json:"interrupted_attempts"`
	// The hub session this admission continued (a resume), null when it started fresh. An older
	// daemon omits it, which the hub reads as "cannot resume".
	ContinuedFrom *string `json:"continued_from"`
}
type admission struct {
	Status
	Token string `json:"token"`
}
type Client struct {
	State, NodeID, Workspace string
	HTTP                     *http.Client
	Runtime                  *Runtime
	BindMCP                  MCPBinder
}

func StationKey(workspace string) string {
	h := sha256.Sum256([]byte(workspace))
	return fmt.Sprintf("salaam:%x", h[:8])
}
func (c *Client) validate(b Binding) error {
	if b.Version != 1 || !regexp.MustCompile(`^org_[a-f0-9]{20}$`).MatchString(b.OrganizationID) || !regexp.MustCompile(`^prn_[a-f0-9]{20}$`).MatchString(b.PrincipalID) || b.NodeID != c.NodeID || c.NodeID == "" || b.StationKey != StationKey(c.Workspace) || b.Workspace != c.Workspace || b.OccupancyEpoch < 1 || b.Run.Epoch < 1 || (b.Run.Source != "agentpod" && b.Run.Source != "superpipeline") || b.StationID == "" || b.HubSessionID == "" || b.Run.ID == "" {
		return fmt.Errorf("salaam: authority binding does not name this node and station")
	}
	return nil
}
func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(c.State, "operator.sock"))
	}}}
}
func (c *Client) Healthy(ctx context.Context) bool {
	if c.Runtime != nil && c.Runtime.Ensure(ctx) != nil {
		return false
	}
	healthy, _ := c.PassiveHealth(ctx)
	return healthy
}

// PassiveHealth observes the private daemon without startup or lifecycle effects.
// An unknown PID stays unknown; it is never fabricated from supervisor records.
type DaemonHealth struct {
	Running             bool
	PID                 *int
	ConfigurationDigest string
	// Reason says why Running is false; empty when healthy.
	Reason string
	// LastActivityAt is the daemon's own `last_activity_at` (RFC3339, UTC), when it reports one.
	// Empty when absent or unparseable; the descriptor then falls back to file times.
	LastActivityAt string
}

func (c *Client) PassiveHealth(ctx context.Context) (bool, *int) {
	health := c.ObserveHealth(ctx)
	return health.Running, health.PID
}
func (c *Client) ObserveHealth(ctx context.Context) DaemonHealth {
	req, err := http.NewRequestWithContext(ctx, "GET", "http://salaam/v1/health", nil)
	if err != nil {
		return DaemonHealth{Reason: err.Error()}
	}
	res, err := c.httpClient().Do(req)
	if err != nil {
		return DaemonHealth{Reason: "operator socket unreachable: " + err.Error()}
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return DaemonHealth{Reason: fmt.Sprintf("health answered HTTP %d", res.StatusCode)}
	}
	var out struct {
		Service             string  `json:"service"`
		AgentPodConfig      *string `json:"agentpod_config"`
		PID                 *int    `json:"pid"`
		ManifestDigest      string  `json:"host_manifest_digest"`
		SupervisorConnected bool    `json:"host_supervisor_connected"`
		RuntimeNode         string  `json:"runtime_node"`
		LastActivityAt      string  `json:"last_activity_at"`
		JobExecution        struct {
			ControlError         any `json:"control_error"`
			ScheduleControlError any `json:"schedule_control_error"`
			InboxControlError    any `json:"inbox_control_error"`
		} `json:"job_execution"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 1024*1024)).Decode(&out) != nil {
		return DaemonHealth{Reason: "health response is not JSON"}
	}
	healthy := out.Service == "healthy" && out.AgentPodConfig != nil && *out.AgentPodConfig != ""
	health := DaemonHealth{Running: healthy}
	switch {
	case out.Service != "healthy":
		health.Reason = fmt.Sprintf("daemon reports service %q", out.Service)
	case !healthy:
		health.Reason = "daemon is not bound to AgentPod (agentpod_config unset): start it with --agentpod-config <pins.json>"
	}
	if healthy && out.PID != nil && *out.PID > 0 {
		health.PID = out.PID
	}
	if at, err := time.Parse(time.RFC3339Nano, out.LastActivityAt); err == nil {
		health.LastActivityAt = at.UTC().Format(time.RFC3339)
	}
	if health.PID != nil && out.SupervisorConnected && regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(out.ManifestDigest) && (c.Runtime == nil || c.Runtime.Node == out.RuntimeNode) && out.JobExecution.ControlError == nil && out.JobExecution.ScheduleControlError == nil && out.JobExecution.InboxControlError == nil {
		health.ConfigurationDigest = out.ManifestDigest
	}
	return health
}
func (c *Client) call(ctx context.Context, action string, body any, out any) error {
	if c.Runtime != nil && (action == "admit" || action == "renew") {
		if err := c.Runtime.Ensure(ctx); err != nil {
			return err
		}
	}
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://salaam/v1/agentpod/"+action, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := c.httpClient()
	// Two reviewed servers can each consume their 30-second catalog deadline.
	// Caller context remains an independent upper bound; model/effect calls never use this path.
	if action == "mcp-assign" && c.HTTP == nil {
		client.Timeout = 70 * time.Second
	}
	// Fresh protected tree/deliverable verification may scan large workspaces.
	// This transport budget does not extend the authority lease.
	if (action == "work-evidence-artifacts" || action == "work-evidence" || action == "work-status" || action == "work-completion") && c.HTTP == nil {
		client.Timeout = 120 * time.Second
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("salaam: authority control unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return fmt.Errorf("salaam: authority request refused (%d)%s", res.StatusCode, refusalReason(res.Body))
	}
	// Only explicitly versioned evidence reads admit a larger response. Existing
	// authority/control receipts retain their original 1 MiB cap.
	if action == "work-evidence-artifacts" || action == "work-evidence" {
		raw, err := io.ReadAll(io.LimitReader(res.Body, (8<<20)+1))
		if err != nil || len(raw) > 8<<20 {
			return fmt.Errorf("salaam: evidence receipt exceeds 8 MiB")
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		if decoder.Decode(out) != nil {
			return fmt.Errorf("salaam: malformed evidence receipt")
		}
		var trailing any
		if decoder.Decode(&trailing) != io.EOF {
			return fmt.Errorf("salaam: trailing evidence receipt")
		}
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1024*1024)).Decode(out); err != nil {
		return fmt.Errorf("salaam: malformed authority receipt")
	}
	return nil
}
func (c *Client) Request(ctx context.Context, action string, b Binding, request string, sequence int64, reason string) (Status, error) {
	var out Status
	if err := c.validate(b); err != nil {
		return out, err
	}
	if action != "admit" && action != "renew" && action != "revoke" && action != "status" {
		return out, fmt.Errorf("salaam: unknown authority action")
	}
	return c.authority(ctx, action, b, map[string]any{"binding": b, "request_id": request, "lease_sequence": sequence, "reason": reason})
}

// RequestWithRules admits or renews carrying the agent's standing approval rules, which Salaam
// validates, pins at admission and drops at the renewal that no longer lists them. Admit and renew
// only: a revoke or status never carries rules.
func (c *Client) RequestWithRules(ctx context.Context, action string, b Binding, request string, sequence int64, rules json.RawMessage) (Status, error) {
	if action != "admit" && action != "renew" {
		return Status{}, fmt.Errorf("salaam: approval rules ride only on admit and renew")
	}
	if err := c.validate(b); err != nil {
		return Status{}, err
	}
	body := map[string]any{"binding": b, "request_id": request, "lease_sequence": sequence, "reason": ""}
	if len(rules) > 0 {
		body["approval_rules"] = rules
	}
	return c.authority(ctx, action, b, body)
}

func (c *Client) authority(ctx context.Context, action string, b Binding, body map[string]any) (Status, error) {
	var out Status
	err := c.call(ctx, action, body, &out)
	if err == nil && (out.Binding != b || out.AdmissionID == "" || out.SessionID == "") {
		return Status{}, fmt.Errorf("salaam: receipt belongs to another admission")
	}
	return out, err
}

// AdmitContinuing admits a binding that carries on an earlier, revoked interactive conversation.
// Salaam decides whether it may; the receipt must say which conversation it continued.
func (c *Client) AdmitContinuing(ctx context.Context, b Binding, request, continueFrom string) (Status, error) {
	var out Status
	if err := c.validate(b); err != nil {
		return out, err
	}
	if request == "" || continueFrom == "" || len(continueFrom) > 128 {
		return out, fmt.Errorf("salaam: missing continuation identity")
	}
	err := c.call(ctx, "admit", map[string]any{"binding": b, "request_id": request, "continue_from": continueFrom}, &out)
	if err == nil && (out.Binding != b || out.AdmissionID == "" || out.SessionID == "") {
		return Status{}, fmt.Errorf("salaam: receipt belongs to another admission")
	}
	if err == nil && (out.ContinuedFrom == nil || *out.ContinuedFrom != continueFrom) {
		return Status{}, fmt.Errorf("salaam: this daemon did not continue the conversation; upgrade Salaam")
	}
	return out, err
}
func (c *Client) ACPEnv(ctx context.Context, b Binding) ([]string, error) {
	if err := c.validate(b); err != nil {
		return nil, err
	}
	var out admission
	if err := c.call(ctx, "admit", map[string]any{"binding": b, "request_id": "open:" + b.HubSessionID}, &out); err != nil {
		return nil, err
	}
	if !out.Authorized || out.Binding != b || out.Token == "" || out.AdmissionID == "" {
		return nil, fmt.Errorf("salaam: fresh bound authority is required")
	}
	return []string{"SALAAM_AGENTPOD_ADMISSION=" + out.AdmissionID, "SALAAM_AGENTPOD_TOKEN=" + out.Token}, nil
}

var refusalCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// refusalReason names why the daemon refused, from its {code, error} body, so a stalled
// strict run says which guard stopped it. Bounded and printable-only: the reason reaches
// hub logs, and a daemon reply never carries prompt or tool content by contract.
func refusalReason(body io.Reader) string {
	var v struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	if json.NewDecoder(io.LimitReader(body, 4096)).Decode(&v) != nil || !refusalCode.MatchString(v.Code) {
		return ""
	}
	msg := []rune(v.Error)
	if len(msg) > 200 {
		msg = msg[:200]
	}
	clean := make([]rune, 0, len(msg))
	for _, r := range msg {
		if r >= 0x20 && r != 0x7f {
			clean = append(clean, r)
		}
	}
	if len(clean) == 0 {
		return ": " + v.Code
	}
	return ": " + v.Code + ": " + string(clean)
}
