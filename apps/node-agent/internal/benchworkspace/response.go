package benchworkspace

import "encoding/json"

const MaxResponse = 1 << 20
const MaxSafeInteger = uint64(1<<53 - 1)

// Response is the proposed v2 envelope. A cached grant is historical evidence,
// never a substitute for current ownership validation by the producer.
type Response struct {
	Version   string    `json:"version"`
	Operation string    `json:"operation,omitempty"`
	RequestID string    `json:"request_id,omitempty"`
	OK        bool      `json:"ok"`
	Result    Result    `json:"result,omitempty"`
	Error     *APIError `json:"error,omitempty"`
}
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Result is closed so an arbitrary private model cannot become a wire result.
type Result interface{ responseResult() }

type Commit struct {
	Name   string `json:"name"`
	Commit string `json:"commit"`
}
type Checkpoint struct {
	GenerationID   string   `json:"generation_id"`
	ManifestSHA256 string   `json:"manifest_sha256"`
	Members        []Commit `json:"members"`
	Seal           string   `json:"seal"`
	PreviousSeal   string   `json:"previous_seal,omitempty"`
}
type Pending struct {
	GenerationID   string   `json:"generation_id"`
	ManifestSHA256 string   `json:"manifest_sha256"`
	Members        []Commit `json:"members"`
	PreviousSeal   string   `json:"previous_seal,omitempty"`
}
type Execution struct {
	ID    string `json:"id"`
	Phase string `json:"phase"`
}
type LeaseSummary struct {
	Holder        string     `json:"holder"`
	Mode          string     `json:"mode"`
	StopRequested bool       `json:"stop_requested"`
	Execution     *Execution `json:"execution,omitempty"`
}
type Grant struct {
	LeaseToken string `json:"lease_token"`
}
type Archive struct {
	ArchivedAt    string `json:"archived_at"`
	ReapAfter     string `json:"reap_after"`
	FreezeDigest  string `json:"freeze_digest"`
	FrozenAt      string `json:"frozen_at,omitempty"`
	ReapingDigest string `json:"reaping_digest,omitempty"`
	ReapedAt      string `json:"reaped_at,omitempty"`
	Automatic     bool   `json:"automatic"`
}
type Recovery struct {
	BenchID        string `json:"bench_id"`
	Seal           string `json:"seal"`
	ManifestSHA256 string `json:"manifest_sha256"`
}
type Workspace struct {
	Key                  string        `json:"key"`
	BenchID              string        `json:"bench_id"`
	Phase                string        `json:"phase"`
	MemberCount          int           `json:"member_count"`
	CheckpointRepository string        `json:"checkpoint_repository"`
	ReadyForAcquisition  bool          `json:"ready_for_acquisition"`
	TransferState        string        `json:"transfer_state,omitempty"`
	QuotaBytes           uint64        `json:"quota_bytes"`
	QuotaInodes          uint64        `json:"quota_inodes"`
	Lease                *LeaseSummary `json:"lease,omitempty"`
	Checkpoint           *Checkpoint   `json:"checkpoint,omitempty"`
	Pending              *Pending      `json:"pending,omitempty"`
	RecoveredFrom        *Recovery     `json:"recovered_from,omitempty"`
	Archive              *Archive      `json:"archive,omitempty"`
}
type Mutation struct {
	Workspace Workspace `json:"workspace"`
	Grant     *Grant    `json:"grant,omitempty"`
	RootPath  string    `json:"root_path,omitempty"`
}

func (*Mutation) responseResult() {}

type RunOutcome struct {
	Mutation
	Execution    *Execution `json:"execution,omitempty"`
	ExitCode     *int       `json:"exit_code,omitempty"`
	LogTruncated *bool      `json:"log_truncated,omitempty"`
}

func (*RunOutcome) responseResult() {}

type Preparation struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}
type SetupOutcome struct {
	RunOutcome
	Preparation []Preparation `json:"preparation"`
}

func (*SetupOutcome) responseResult() {}

type Member struct {
	Name         string `json:"name"`
	Branch       string `json:"branch"`
	Base         string `json:"base"`
	ObjectFormat string `json:"object_format"`
	SourceCommit string `json:"source_commit"`
}
type Inventory interface{ inventory() }
type WorkspaceInventory struct {
	Workspace
	Kind    string   `json:"kind"`
	Members []Member `json:"members"`
}

func (*WorkspaceInventory) inventory() {}

type ScalarArchive struct {
	ArchivedAt    string `json:"archived_at"`
	ReapAfter     string `json:"reap_after,omitempty"`
	FreezeDigest  string `json:"freeze_digest,omitempty"`
	FrozenAt      string `json:"frozen_at,omitempty"`
	ReapingDigest string `json:"reaping_digest,omitempty"`
	ReapedAt      string `json:"reaped_at,omitempty"`
	Automatic     bool   `json:"automatic"`
}
type ScalarInventory struct {
	Kind        string         `json:"kind"`
	Key         string         `json:"key"`
	Branch      string         `json:"branch"`
	State       string         `json:"state"`
	QuotaBytes  uint64         `json:"quota_bytes"`
	QuotaInodes uint64         `json:"quota_inodes"`
	Checkpoint  string         `json:"checkpoint,omitempty"`
	Lease       *LeaseSummary  `json:"lease,omitempty"`
	Archive     *ScalarArchive `json:"archive,omitempty"`
}

func (*ScalarInventory) inventory() {}

type Status struct {
	Benches []Inventory `json:"benches"`
}

func (*Status) responseResult() {}
func (s *Status) UnmarshalJSON(raw []byte) error {
	fields, ok := fieldSet(raw, []string{"benches"}, nil)
	if !ok {
		return ErrResponse
	}
	var entries []json.RawMessage
	if json.Unmarshal(fields["benches"], &entries) != nil || len(entries) > 100000 {
		return ErrResponse
	}
	s.Benches = make([]Inventory, 0, len(entries))
	for _, entry := range entries {
		var discriminator struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(entry, &discriminator) != nil {
			return ErrResponse
		}
		var item Inventory
		switch discriminator.Kind {
		case "workspace":
			item = &WorkspaceInventory{}
		case "scalar":
			item = &ScalarInventory{}
		default:
			return ErrResponse
		}
		if err := decodeResponseObject(entry, item); err != nil {
			return err
		}
		s.Benches = append(s.Benches, item)
	}
	return nil
}

type HostStatus struct {
	Managed        bool   `json:"managed"`
	DataFreeBytes  uint64 `json:"data_free_bytes"`
	StateFreeBytes uint64 `json:"state_free_bytes"`
}

func (*HostStatus) responseResult() {}

// KeyAbsent reports a definite answer that the key has no bench. The contract
// answers a specific-key status with exactly that key's record or not_found,
// so not_found on such a status is absence, not an error. Every other reply
// is not: unavailable and the rest are unknowns, a not_found without the
// status operation (an unknown route or version) says nothing about the key,
// and a global status (no key) never answers not_found.
func KeyAbsent(request Request, reply Response) bool {
	return request.Operation == "status" && request.Key != "" && reply.Operation == "status" && !reply.OK &&
		reply.Error != nil && reply.Error.Code == "not_found"
}
