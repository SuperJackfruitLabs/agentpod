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
}
type admission struct {
	Status
	Token string `json:"token"`
}
type Client struct {
	State, NodeID, Workspace string
	HTTP                     *http.Client
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
	req, err := http.NewRequestWithContext(ctx, "GET", "http://salaam/v1/health", nil)
	if err != nil {
		return false
	}
	res, err := c.httpClient().Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return false
	}
	var out struct {
		Service        string  `json:"service"`
		AgentPodConfig *string `json:"agentpod_config"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 1024*1024)).Decode(&out) != nil {
		return false
	}
	return out.Service == "healthy" && out.AgentPodConfig != nil && *out.AgentPodConfig != ""
}
func (c *Client) call(ctx context.Context, action string, body any, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://salaam/v1/agentpod/"+action, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("salaam: authority control unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return fmt.Errorf("salaam: authority request refused (%d)", res.StatusCode)
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
	err := c.call(ctx, action, map[string]any{"binding": b, "request_id": request, "lease_sequence": sequence, "reason": reason}, &out)
	if err == nil && (out.Binding != b || out.AdmissionID == "" || out.SessionID == "") {
		return Status{}, fmt.Errorf("salaam: receipt belongs to another admission")
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
