// Package benchcoordinatorwire defines PROPOSED data, not an enabled broker verb
// or authority. Local paths, arguments, environments and capabilities are absent.
package benchcoordinatorwire

const Version = "agentpod.bench-coordinator.v1"
const MaxRequest = 64 << 10
const MaxResponse = 256 << 10

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
	// ControlGrantID is an opaque selected-authorization snapshot, NOT an issuer grant.
	ControlGrantID string `json:"control_grant_id"`
	PolicySHA256   string `json:"policy_sha256"`
}
type Target struct {
	TenantID                        string `json:"tenant_id"`
	BoardID                         string `json:"board_id"`
	AgentID                         string `json:"agent_id"`
	StationID                       string `json:"station_id"`
	NodeID                          string `json:"node_id"`
	HostID                          string `json:"host_id"`
	RegistrySHA256                  string `json:"registry_sha256"`
	CoordinatorImplementationSHA256 string `json:"coordinator_implementation_sha256"`
	ExecutionMode                   string `json:"execution_mode"`
	BenchProtocol                   string `json:"bench_protocol"`
	WorkerVersion                   string `json:"worker_version"`
	WorkerSHA256                    string `json:"worker_sha256"`
}
type Source struct {
	Name             string `json:"name"`
	RepositorySHA256 string `json:"repository_sha256"`
	TaskRef          string `json:"task_ref"`
	Commit           string `json:"commit"`
}
type Member struct {
	Name             string `json:"name"`
	RepositorySHA256 string `json:"repository_sha256"`
	TaskRef          string `json:"task_ref"`
	ObjectFormat     string `json:"object_format"`
	Commit           string `json:"commit"`
}
type CheckpointMember struct {
	Name   string `json:"name"`
	Commit string `json:"commit"`
}
type Checkpoint struct {
	GenerationID   string             `json:"generation_id"`
	ManifestSHA256 string             `json:"manifest_sha256"`
	Members        []CheckpointMember `json:"members"`
	Seal           string             `json:"seal"`
	PreviousSeal   string             `json:"previous_seal,omitempty"`
}
type Operation struct {
	Step           string `json:"step"`
	RequestSHA256  string `json:"request_sha256"`
	BodySHA256     string `json:"body_sha256"`
	ResponseSHA256 string `json:"response_sha256"`
	HTTPStatus     int    `json:"http_status"`
	Phase          string `json:"phase"`
}

// SourceBinding field order matches the private observed projection. Its digest
// identifies exact data; it is neither a signature nor a fence/admission proof.
type SourceBinding struct {
	Identity      Identity    `json:"identity"`
	HostID        string      `json:"host_id"`
	BenchKey      string      `json:"bench_key"`
	BenchID       string      `json:"bench_id"`
	Sources       []Source    `json:"sources"`
	Members       []Member    `json:"members"`
	Checkpoint    Checkpoint  `json:"checkpoint"`
	Operations    []Operation `json:"operations"`
	RequestSHA256 string      `json:"request_sha256"`
	BodySHA256    string      `json:"body_sha256"`
	ContextSHA256 string      `json:"context_sha256"`
	WorkerSHA256  string      `json:"worker_sha256"`
}
type Prepared struct {
	Binding              SourceBinding `json:"binding"`
	BindingSHA256        string        `json:"binding_sha256"`
	RequestID            string        `json:"request_id"`
	CheckpointRepository string        `json:"checkpoint_repository"`
	SourceRequestSHA256  string        `json:"source_request_sha256"`
}
type Service struct {
	RequestID          string   `json:"request_id"`
	RequestSHA256      string   `json:"request_sha256"`
	BodySHA256         string   `json:"body_sha256"`
	ResponseSHA256     string   `json:"response_sha256"`
	WorkerResultSHA256 string   `json:"worker_result_sha256"`
	ExecutionID        string   `json:"execution_id"`
	Stopped            bool     `json:"stopped"`
	Released           bool     `json:"released"`
	Checkpoints        []Source `json:"checkpoints"`
	Kind               string   `json:"kind"`
	GenerationID       string   `json:"generation_id"`
	SealCommit         string   `json:"seal_commit"`
	ManifestSHA256     string   `json:"manifest_sha256"`
}
type WorkerBinding struct {
	BoardID string `json:"board_id"`
	CardID  string `json:"card_id"`
	RunID   string `json:"run_id"`
	Epoch   uint64 `json:"epoch"`
}
type WorkerResult struct {
	Version string        `json:"version"`
	Binding WorkerBinding `json:"binding"`
	Outcome string        `json:"outcome"`
	// Handoff is untrusted child text, including any URLs; never source evidence.
	Handoff map[string]string `json:"handoff"`
}
type Completion struct {
	Source              Prepared     `json:"source"`
	Service             Service      `json:"service"`
	Task                WorkerResult `json:"task"`
	SourceRequestSHA256 string       `json:"source_request_sha256"`
	SourceReceiptSHA256 string       `json:"source_receipt_sha256"`
}
type Receipt struct {
	RunID        string `json:"run_id"`
	Epoch        uint64 `json:"epoch"`
	SourceDigest string `json:"source_digest"`
	AdmittedAt   uint64 `json:"admitted_at"`
}
type Task struct {
	ProfileID      string `json:"profile_id"`
	Prompt         string `json:"prompt"`
	TimeoutSeconds uint64 `json:"timeout_seconds"`
	RepositoryName string `json:"repository_name,omitempty"`
}
type Request struct {
	Version       string    `json:"version"`
	Operation     string    `json:"operation"`
	TenantID      string    `json:"tenant_id,omitempty"`
	BoardID       string    `json:"board_id,omitempty"`
	StationID     string    `json:"station_id,omitempty"`
	Identity      *Identity `json:"identity,omitempty"`
	Target        *Target   `json:"target,omitempty"`
	Task          *Task     `json:"task,omitempty"`
	BindingSHA256 string    `json:"binding_sha256,omitempty"`
	SourceReceipt *Receipt  `json:"source_receipt,omitempty"`
}
type Response struct {
	Version    string      `json:"version"`
	Operation  string      `json:"operation"`
	State      string      `json:"state"`
	Code       string      `json:"code,omitempty"`
	Identity   *Identity   `json:"identity,omitempty"`
	Target     *Target     `json:"target,omitempty"`
	Source     *Prepared   `json:"source,omitempty"`
	Completion *Completion `json:"completion,omitempty"`
}
