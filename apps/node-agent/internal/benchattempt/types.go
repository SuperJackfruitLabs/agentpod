// Package benchattempt owns the private serialized identity and data of a node
// attempt. It supplies no authorization, journal mutation, or public wire API.
package benchattempt

import (
	"encoding/json"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

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

type Source struct {
	Name             string `json:"name"`
	RepositorySHA256 string `json:"repository_sha256"`
	TaskRef          string `json:"task_ref"`
	Commit           string `json:"commit"`
}

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
	Plan           Plan               `json:"plan"`
	Source         *SourceReservation `json:"source,omitempty"`
	Phase          string             `json:"phase"`
	Proposal       json.RawMessage    `json:"proposal,omitempty"`
	ProposalSHA256 string             `json:"proposal_sha256,omitempty"`
}

type SourceSpec struct {
	Identity             Identity           `json:"identity"`
	HostID               string             `json:"host_id"`
	BenchKey             string             `json:"bench_key"`
	Holder               string             `json:"holder"`
	ContextParent        string             `json:"context_parent"`
	DataRoot             string             `json:"data_root"`
	CheckpointRepository string             `json:"checkpoint_repository"`
	Repositories         []SourceRepository `json:"repositories"`
	WorkerPath           string             `json:"worker_path"`
	WorkerSHA256         string             `json:"worker_sha256"`
	TaskSHA256           string             `json:"task_sha256"`
	Create               bool               `json:"create"`
	CreateRequestID      string             `json:"create_request_id,omitempty"`
	LeaseRequestID       string             `json:"lease_request_id"`
	RunRequestID         string             `json:"run_request_id"`
}

type SourceRepository struct {
	Name             string `json:"name"`
	RepositorySHA256 string `json:"repository_sha256"`
	TaskRef          string `json:"task_ref"`
	Base             string `json:"base"`
	ObjectFormat     string `json:"object_format"`
}

type SourceOperation struct {
	Step           string `json:"step"`
	RequestSHA256  string `json:"request_sha256"`
	BodySHA256     string `json:"body_sha256"`
	ResponseSHA256 string `json:"response_sha256,omitempty"`
	HTTPStatus     int    `json:"http_status,omitempty"`
	Phase          string `json:"phase"`
}

type SourceReservation struct {
	Spec       SourceSpec        `json:"spec"`
	Operations []SourceOperation `json:"operations"`
}

// Cancellation is a private append-only veto, never a stopped/released claim.
type Cancellation struct {
	IdentitySHA256 string               `json:"identity_sha256"`
	SourceSHA256   string               `json:"source_sha256"`
	Observations   []CleanupObservation `json:"observations,omitempty"`
}
type CleanupObservation struct {
	Operation       string `json:"operation"`
	TargetRequestID string `json:"target_request_id,omitempty"`
	TargetDigest    string `json:"target_digest"`
	State           string `json:"state"`
}
