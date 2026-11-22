package benchbridge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchjournal"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

var ErrRegistry = errors.New("checkpoint coordinator registry unavailable")

// Registry is private operator configuration. Clone identities and commands
// never arrive in a broker request or enter a public response.
type Registry struct {
	Version           string         `json:"version"`
	NodeID            string         `json:"node_id"`
	HostID            string         `json:"host_id"`
	Socket            string         `json:"socket"`
	StateRoot         string         `json:"state_root"`
	IntentRoot        string         `json:"intent_root"`
	DataRoot          string         `json:"data_root"`
	ContextParent     string         `json:"context_parent"`
	WorkerPath        string         `json:"worker_path"`
	WorkerSHA256      string         `json:"worker_sha256"`
	CoordinatorSHA256 string         `json:"coordinator_implementation_sha256"`
	Profiles          []LocalProfile `json:"profiles"`
}
type LocalProfile struct {
	ID                   string            `json:"id"`
	TenantID             string            `json:"tenant_id"`
	BoardID              string            `json:"board_id"`
	AgentID              string            `json:"agent_id"`
	StationID            string            `json:"station_id"`
	CheckpointRepository string            `json:"checkpoint_repository"`
	Repositories         []LocalRepository `json:"repositories"`
	Arguments            []string          `json:"arguments"`
	Environment          map[string]string `json:"environment"`
	// Launch selects the worker transport. Empty keeps the grouped context
	// launch; "registered-v1" opts in to the finite stdin transport.
	Launch string `json:"launch,omitempty"`
}
type LocalRepository struct {
	Name         string `json:"name"`
	Repository   string `json:"repository"`
	Base         string `json:"base"`
	ObjectFormat string `json:"object_format"`
}

func executableHash(path string) (string, error) {
	if !benchjournal.PhysicalName(path) {
		return "", ErrRegistry
	}
	real, err := filepath.EvalSymlinks(path)
	st, e := os.Stat(path)
	if err != nil || e != nil || real != path || !st.Mode().IsRegular() || st.Mode().Perm()&0111 == 0 || st.Size() > 256<<20 {
		return "", ErrRegistry
	}
	// Packaging is trusted local configuration. Hash exact installed bytes; this
	// does not turn a checksum into process isolation or remote attestation.
	raw, err := benchjournal.ReadFile(path, 256<<20, false)
	if err != nil {
		return "", ErrRegistry
	}
	return rawSHA(raw), nil
}

// RegistryVersion is the private registry file's only version.
const RegistryVersion = "agentpod.private-coordinator-registry.v1"

// MaxRegistryProfiles bounds one node's registry. Zero is allowed: a host can install its
// registry with no stage yet, and `fleet bench stage add` writes the first one.
const MaxRegistryProfiles = 16

const maxRegistryBytes = 64 << 10

func readRegistryRaw(path string) ([]byte, error) {
	if benchjournal.PhysicalDir(filepath.Dir(path), true) != nil {
		return nil, ErrRegistry
	}
	raw, err := benchjournal.ReadFile(path, maxRegistryBytes, true)
	if err != nil {
		return nil, ErrRegistry
	}
	return raw, nil
}

func readRegistry(path, nodeID string) (Registry, string, error) {
	raw, err := readRegistryRaw(path)
	if err != nil {
		return Registry{}, "", ErrRegistry
	}
	return parseRegistry(raw, nodeID)
}

// parseRegistry validates exact registry bytes. The digest it returns is the sha256 of those
// bytes, the target's `registry_sha256`.
func parseRegistry(raw []byte, nodeID string) (Registry, string, error) {
	var r Registry
	err := benchjournal.Decode(raw, &r)
	if err != nil || r.Version != RegistryVersion || r.NodeID != nodeID ||
		len(r.Profiles) > MaxRegistryProfiles || !benchjournal.PhysicalName(r.Socket) {
		return Registry{}, "", ErrRegistry
	}
	for _, p := range []string{r.StateRoot, r.IntentRoot, r.ContextParent} {
		if benchjournal.PhysicalDir(p, true) != nil {
			return Registry{}, "", ErrRegistry
		}
	}
	if benchjournal.PhysicalDir(r.DataRoot, false) != nil {
		return Registry{}, "", ErrRegistry
	}
	seenPaths := map[string]bool{}
	for _, private := range []string{r.StateRoot, r.IntentRoot, r.ContextParent} {
		rel, e := filepath.Rel(r.DataRoot, private)
		if e != nil || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) || seenPaths[private] {
			return Registry{}, "", ErrRegistry
		}
		seenPaths[private] = true
	}
	worker, err := executableHash(r.WorkerPath)
	self, e := os.Executable()
	if err != nil || e != nil || worker != r.WorkerSHA256 {
		return Registry{}, "", ErrRegistry
	}
	self, e = filepath.EvalSymlinks(self)
	own, err := executableHash(self)
	if e != nil || err != nil || own != r.CoordinatorSHA256 {
		return Registry{}, "", ErrRegistry
	}
	seen := map[string]bool{}
	selectors := map[string]bool{}
	for _, p := range r.Profiles {
		target := r.target(p, rawSHA(raw))
		request := benchcoordinatorwire.Request{Version: benchcoordinatorwire.Version, Operation: "ready", TenantID: p.TenantID, BoardID: p.BoardID, StationID: p.StationID}
		encoded, _ := json.Marshal(request)
		if _, err = benchcoordinatorwire.ParseRequest(encoded); err != nil || p.ID == "" || seen[p.ID] || len(p.Arguments) == 0 || len(p.Arguments) > 128 || p.Environment == nil {
			return Registry{}, "", ErrRegistry
		}
		if p.Launch != "" && p.Launch != benchlaunch.Mode {
			return Registry{}, "", ErrRegistry
		}
		seen[p.ID] = true
		selector := p.TenantID + "\x00" + p.BoardID + "\x00" + p.StationID
		if selectors[selector] || !benchjournal.PhysicalName(p.Arguments[0]) {
			return Registry{}, "", ErrRegistry
		}
		selectors[selector] = true
		// The complete target is also validated independently of any claimed run.
		response := benchcoordinatorwire.Response{Version: benchcoordinatorwire.Version, Operation: "ready", State: "available", Target: &target}
		encoded, _ = json.Marshal(response)
		if _, err = benchcoordinatorwire.ParseResponse(encoded, request); err != nil {
			return Registry{}, "", ErrRegistry
		}
		repos := make([]benchworkspace.Repository, 0, len(p.Repositories))
		prior := ""
		for _, repo := range p.Repositories {
			if repo.Name <= prior || repo.ObjectFormat != "sha1" && repo.ObjectFormat != "sha256" {
				return Registry{}, "", ErrRegistry
			}
			prior = repo.Name
			repos = append(repos, benchworkspace.Repository{Name: repo.Name, Repository: repo.Repository, Base: repo.Base})
		}
		initialize := true
		encoded, _ = json.Marshal(benchworkspace.Request{Version: benchworkspace.Version, Operation: "create", Key: "registry_validation", Repositories: repos, CheckpointRepository: p.CheckpointRepository, Initialize: &initialize, RequestID: "registry_validation"})
		if _, err = benchworkspace.Parse(encoded); err != nil {
			return Registry{}, "", ErrRegistry
		}
		for k, v := range p.Environment {
			if k != "PATH" && k != "LANG" && k != "LC_ALL" && k != "TZ" && k != "TERM" || strings.ContainsAny(v, "\x00\r\n") {
				return Registry{}, "", ErrRegistry
			}
		}
		for _, arg := range p.Arguments {
			if strings.ContainsRune(arg, 0) || len(arg) > 8192 {
				return Registry{}, "", ErrRegistry
			}
		}
	}
	return r, rawSHA(raw), nil
}
func (r Registry) target(p LocalProfile, digest string) benchcoordinatorwire.Target {
	return benchcoordinatorwire.Target{TenantID: p.TenantID, BoardID: p.BoardID, AgentID: p.AgentID, StationID: p.StationID, NodeID: r.NodeID,
		HostID: r.HostID, RegistrySHA256: digest, CoordinatorImplementationSHA256: r.CoordinatorSHA256, ExecutionMode: "linux-cgroup-v2", BenchProtocol: benchworkspace.Version,
		WorkerVersion: "agentpod.superbench-worker.v2", WorkerSHA256: r.WorkerSHA256}
}
func managed(ctx context.Context, client *benchworkspace.Client) error {
	if runtime.GOOS != "linux" {
		return ErrRegistry
	}
	reply, err := client.Do(ctx, benchworkspace.Request{Version: benchworkspace.Version, Operation: "host_status"})
	if err != nil || reply == nil {
		return ErrRegistry
	}
	host, ok := reply.Result.(*benchworkspace.HostStatus)
	if !ok || !host.Managed {
		return ErrRegistry
	}
	return nil
}
