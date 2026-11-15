// Package benchdispatch is a private node-side dispatch journal. It records
// observations and proposed settlement, never board authorization or acceptance.
// Its callbacks are trust seams for a future reviewed adapter, not certifiers.
package benchdispatch

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

const version = "agentpod.private-bench-dispatch.v1"
const maxState = 4 << 20
const maxRecords = 256

var (
	ErrInvalid    = errors.New("invalid private dispatch data")
	ErrPending    = errors.New("dispatch may have started; reconciliation required")
	ErrOwner      = errors.New("dispatch owner is not current")
	ErrConflict   = errors.New("immutable dispatch data conflicts")
	ErrVerify     = errors.New("dispatch observation not verified")
	idPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`)
	hexPattern    = regexp.MustCompile(`^[a-f0-9]{64}$`)
	commitPattern = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)
)

// Identity binds one attempt to its original owner. A reclaimed run is a NEW
// identity; it cannot reuse another run's observation or proposed settlement.
type Identity struct {
	TenantID           string `json:"tenant_id"`
	BoardID            string `json:"board_id"`
	CardID             string `json:"card_id"`
	StageID            string `json:"stage_id"`
	RunID              string `json:"run_id"`
	Epoch              uint64 `json:"epoch"`
	AgentID            string `json:"agent_id"`
	StationID          string `json:"station_id"`
	NodeID             string `json:"node_id"`
	AttemptID          string `json:"attempt_id"`
	ControlPrincipalID string `json:"control_principal_id"`
	ControlGrantID     string `json:"control_grant_id"`
	PolicySHA256       string `json:"policy_sha256"`
}

// Source contains credential-free repository identity hashes, never repository
// URLs or arbitrary child-supplied links. The adapter must authorize this vector.
type Source struct {
	Name             string `json:"name"`
	RepositorySHA256 string `json:"repository_sha256"`
	TaskRef          string `json:"task_ref"`
	Commit           string `json:"commit"`
}

// GroupedLaunch binds the protected worker's complete expected start vector.
// It contains no continuation token. Omission preserves scalar-v1 plan bytes.
type GroupedLaunch struct {
	WorkspaceRoot  string                     `json:"workspace_root"`
	RepositoryName string                     `json:"repository_name,omitempty"`
	Members        []superbench.GroupedMember `json:"members"`
}

type Plan struct {
	Identity         Identity       `json:"identity"`
	Grouped          *GroupedLaunch `json:"grouped,omitempty"`
	HostID           string         `json:"host_id"`
	BenchKey         string         `json:"bench_key"`
	RegistrationID   string         `json:"registration_id"`
	Holder           string         `json:"holder"`
	Sources          []Source       `json:"sources"`
	RequestID        string         `json:"request_id"`
	RequestSHA256    string         `json:"request_sha256"` // Exact raw request bytes.
	BodySHA256       string         `json:"body_sha256"`    // Producer's normalized body digest.
	ContextPath      string         `json:"context_path"`
	ContextSHA256    string         `json:"context_sha256"` // Exact private request.json bytes.
	ExecutablePath   string         `json:"executable_path"`
	ExecutableSHA256 string         `json:"executable_sha256"`
}

// Observation is data, not a capability. Verify must independently bind these
// facts to trusted service receipts and the exact private worker result. A
// successful child, status read, or locally supplied boolean is insufficient.
type Observation struct {
	RequestID          string   `json:"request_id"`
	RequestSHA256      string   `json:"request_sha256"`
	BodySHA256         string   `json:"body_sha256"`
	ResponseSHA256     string   `json:"response_sha256"`
	WorkerResultSHA256 string   `json:"worker_result_sha256"`
	ExecutionID        string   `json:"execution_id"`
	Stopped            bool     `json:"stopped"`
	Released           bool     `json:"released"`
	Checkpoints        []Source `json:"checkpoints"`
	Kind               string   `json:"kind"` // scalar-v1 or proposed grouped-v2; no API negotiation.
	GenerationID       string   `json:"generation_id,omitempty"`
	SealCommit         string   `json:"seal_commit,omitempty"`
	ManifestSHA256     string   `json:"manifest_sha256,omitempty"`
}

type Proposal struct {
	Version     string      `json:"version"`
	PlanSHA256  string      `json:"plan_sha256"`
	Plan        Plan        `json:"plan"`
	Observation Observation `json:"observation"`
}

type Record struct {
	Plan           Plan            `json:"plan"`
	Phase          string          `json:"phase"`
	Proposal       json.RawMessage `json:"proposal,omitempty"`
	ProposalSHA256 string          `json:"proposal_sha256,omitempty"`
}

type state struct {
	Version  string   `json:"version"`
	BenchKey string   `json:"bench_key"`
	Active   string   `json:"active,omitempty"`
	Records  []Record `json:"records"`
}

func digest(b []byte) string   { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }
func planID(p Plan) string     { b, _ := json.Marshal(p.Identity); return digest(b) }
func planDigest(p Plan) string { b, _ := json.Marshal(p); return digest(b) }
func samePlan(a, b Plan) bool  { return planDigest(a) == planDigest(b) }

func validatePlan(p Plan) error {
	ids := []string{p.Identity.TenantID, p.Identity.BoardID, p.Identity.CardID, p.Identity.StageID, p.Identity.RunID, p.Identity.AgentID, p.Identity.StationID, p.Identity.NodeID, p.Identity.AttemptID, p.Identity.ControlPrincipalID, p.Identity.ControlGrantID, p.HostID, p.RegistrationID}
	for _, s := range ids {
		if !idPattern.MatchString(s) {
			return ErrInvalid
		}
	}
	if p.Identity.Epoch == 0 {
		return ErrInvalid
	}
	for _, h := range []string{p.Identity.PolicySHA256, p.RequestSHA256, p.BodySHA256, p.ContextSHA256, p.ExecutableSHA256} {
		if !hexPattern.MatchString(h) {
			return ErrInvalid
		}
	}
	if !validSources(p.Sources) || !physicalName(p.ContextPath) || !physicalName(p.ExecutablePath) || len(p.ContextPath) > 4096 || len(p.ExecutablePath) > 4096 {
		return ErrInvalid
	}
	if p.Grouped != nil {
		return validateGroupedPlan(p)
	}
	// Validate the producer's own scalar request identity rules without inventing
	// a held-token run extension. Actual raw arguments are bound at Dispatch.
	raw, _ := json.Marshal(superbench.Request{Version: superbench.Version, Operation: "run", Key: p.BenchKey, Holder: p.Holder, RequestID: p.RequestID, Arguments: []string{p.ExecutablePath, p.ContextPath}})
	_, err := superbench.Parse(raw)
	if err != nil {
		return ErrInvalid
	}
	return nil
}
func validSources(v []Source) bool {
	if len(v) == 0 || len(v) > 32 {
		return false
	}
	names := map[string]bool{}
	targets := map[string]bool{}
	for i, s := range v {
		if !idPattern.MatchString(s.Name) || names[s.Name] || (i > 0 && v[i-1].Name >= s.Name) || !hexPattern.MatchString(s.RepositorySHA256) || !commitPattern.MatchString(s.Commit) || !validRef(s.TaskRef) {
			return false
		}
		target := s.RepositorySHA256 + "\x00" + s.TaskRef
		if targets[target] {
			return false
		}
		targets[target] = true
		names[s.Name] = true
	}
	return true
}
func validRef(s string) bool {
	if len(s) > 4096 || !strings.HasPrefix(s, "refs/heads/") || strings.ContainsAny(s, " ~^:?*[\\\x7f") || strings.Contains(s, "..") || strings.Contains(s, "@{") || strings.HasSuffix(s, ".") {
		return false
	}
	for _, r := range s {
		if r < 32 {
			return false
		}
	}
	for _, c := range strings.Split(s, "/") {
		if c == "" || strings.HasPrefix(c, ".") || strings.HasSuffix(c, ".lock") {
			return false
		}
	}
	return true
}
func validateObservation(p Plan, o Observation) error {
	if o.RequestID != p.RequestID || o.RequestSHA256 != p.RequestSHA256 || o.BodySHA256 != p.BodySHA256 || !idPattern.MatchString(o.ExecutionID) || !o.Stopped || !o.Released || !hexPattern.MatchString(o.ResponseSHA256) || !hexPattern.MatchString(o.WorkerResultSHA256) || !validSources(o.Checkpoints) || len(o.Checkpoints) != len(p.Sources) {
		return ErrVerify
	}
	for i, s := range p.Sources {
		c := o.Checkpoints[i]
		if s.Name != c.Name || s.RepositorySHA256 != c.RepositorySHA256 || s.TaskRef != c.TaskRef {
			return ErrVerify
		}
	}
	switch o.Kind {
	case "scalar-v1":
		if p.Grouped != nil {
			return ErrVerify
		}
		if len(o.Checkpoints) != 1 || o.GenerationID != "" || o.SealCommit != "" || o.ManifestSHA256 != "" {
			return ErrVerify
		}
	case "grouped-v2":
		if p.Grouped == nil {
			return ErrVerify
		}
		if len(o.GenerationID) != 32 || !hexPattern.MatchString(o.GenerationID+o.GenerationID) || !commitPattern.MatchString(o.SealCommit) || !hexPattern.MatchString(o.ManifestSHA256) {
			return ErrVerify
		}
	default:
		return ErrVerify
	}
	return nil
}
