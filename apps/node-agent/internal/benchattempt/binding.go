package benchattempt

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// SourceBinding is a credential-free observation of exact preserved producer
// replies. It is not an admission, signature, or proof of an isolated writer.
type SourceBinding struct {
	Identity      Identity                   `json:"identity"`
	HostID        string                     `json:"host_id"`
	BenchKey      string                     `json:"bench_key"`
	BenchID       string                     `json:"bench_id"`
	Sources       []Source                   `json:"sources"`
	Members       []superbench.GroupedMember `json:"members"`
	Checkpoint    benchworkspace.Checkpoint  `json:"checkpoint"`
	Operations    []SourceOperation          `json:"operations"`
	RequestSHA256 string                     `json:"request_sha256"`
	BodySHA256    string                     `json:"body_sha256"`
	ContextSHA256 string                     `json:"context_sha256"`
	WorkerSHA256  string                     `json:"worker_sha256"`
}
