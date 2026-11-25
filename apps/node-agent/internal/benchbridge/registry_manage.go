package benchbridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchjournal"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchremote"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// The registry is written from the hub (`fleet bench stage add|set|rm`) through three node
// verbs. The host fields (socket, roots, worker path) are never written here: they are the bench
// host's installation, and a request that could move them could point the coordinator at another
// daemon. Only the profiles change, plus, on an explicit repin, the two installed-byte pins.
const (
	VerbRegistryStatus = "bench.registry.status"
	VerbRegistrySet    = "bench.registry.set"
	VerbRegistryRemove = "bench.registry.remove"
	// ManageCapability says a node answers the three verbs above.
	ManageCapability = "bench.registry.manage"
)

// Registry problems, a closed set. Each names the one thing an operator fixes.
const (
	ProblemUnconfigured   = "unconfigured"    // the node config has no proposedCheckpointRegistry
	ProblemUnreadable     = "unreadable"      // missing, not private, or in a non-private directory
	ProblemMalformed      = "malformed"       // not the registry grammar, or another node's
	ProblemWorkerPin      = "worker_pin"      // the installed worker's bytes differ from worker_sha256
	ProblemCoordinatorPin = "coordinator_pin" // this node binary differs from coordinator_implementation_sha256
	ProblemInvalid        = "invalid"         // a root, a profile or a repository fails validation
)

// Refusal is a registry write the node did not make. Code is closed; Message is a fixed sentence
// that carries no path, clone URL or argument.
type Refusal struct {
	Code    string
	Message string
}

func (r *Refusal) Error() string { return r.Code + ": " + r.Message }

// ProfileChange is one stage's node half as the hub sends it. The selector fields are always
// sent. The rest may be omitted on an existing profile, which keeps its current value; a new
// profile needs them all. Clone identities and arguments travel hub to node only and are never
// echoed back.
type ProfileChange struct {
	ID                   string            `json:"id"`
	TenantID             string            `json:"tenant_id"`
	BoardID              string            `json:"board_id"`
	AgentID              string            `json:"agent_id"`
	StationID            string            `json:"station_id"`
	CheckpointRepository string            `json:"checkpoint_repository,omitempty"`
	Repositories         []LocalRepository `json:"repositories,omitempty"`
	Arguments            []string          `json:"arguments,omitempty"`
	Environment          map[string]string `json:"environment,omitempty"`
	Launch               *string           `json:"launch,omitempty"`
}

// SetRequest is `bench.registry.set`. Repin re-pins worker_sha256 and
// coordinator_implementation_sha256 to the bytes installed now, for after a worker or node update.
type SetRequest struct {
	Profile *ProfileChange `json:"profile,omitempty"`
	Repin   bool           `json:"repin,omitempty"`
}

// RemoveRequest is `bench.registry.remove`.
type RemoveRequest struct {
	ID string `json:"id"`
}

// RepositoryView is a registry repository without its clone identity.
type RepositoryView struct {
	Name             string `json:"name"`
	RepositorySHA256 string `json:"repository_sha256"`
	ObjectFormat     string `json:"object_format"`
	Base             string `json:"base,omitempty"`
}

// ProfileView is what the node serves for one profile: the exact target its `ready` advertises.
type ProfileView struct {
	ID                   string                      `json:"id"`
	CheckpointRepository string                      `json:"checkpoint_repository"`
	Repositories         []RepositoryView            `json:"repositories"`
	Launch               string                      `json:"launch,omitempty"`
	Target               benchcoordinatorwire.Target `json:"target"`
}

// BenchdView is the bench daemon as the node sees it through the registry's socket.
type BenchdView struct {
	Reachable      bool   `json:"reachable"`
	Managed        bool   `json:"managed"`
	DataFreeBytes  uint64 `json:"data_free_bytes"`
	StateFreeBytes uint64 `json:"state_free_bytes"`
}

// RegistryStatus is the reply to every registry verb.
type RegistryStatus struct {
	Configured                 bool          `json:"configured"`
	Valid                      bool          `json:"valid"`
	Problem                    string        `json:"problem,omitempty"`
	NodeID                     string        `json:"node_id"`
	HostID                     string        `json:"host_id,omitempty"`
	RegistrySHA256             string        `json:"registry_sha256,omitempty"`
	WorkerSHA256               string        `json:"worker_sha256,omitempty"`
	WorkerInstalledSHA256      string        `json:"worker_installed_sha256,omitempty"`
	CoordinatorSHA256          string        `json:"coordinator_implementation_sha256,omitempty"`
	CoordinatorInstalledSHA256 string        `json:"coordinator_installed_sha256,omitempty"`
	Benchd                     *BenchdView   `json:"benchd,omitempty"`
	Profiles                   []ProfileView `json:"profiles"`
}

// RegistryManager edits one node's private registry. Writes are serialised, atomic (a temporary
// file in the same private directory, renamed over the old one) and validated as the complete
// new file before the rename, so a refused change leaves the installed registry byte for byte.
// Reload runs after each successful write, so the coordinator serves the new file with no restart.
type RegistryManager struct {
	Path   string
	NodeID string
	Reload func()

	mu sync.Mutex
}

func ownExecutable() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(self)
}

// diagnose names why decoded registry bytes do not parse.
func diagnose(r Registry) string {
	if worker, err := executableHash(r.WorkerPath); err != nil || worker != r.WorkerSHA256 {
		return ProblemWorkerPin
	}
	self, err := ownExecutable()
	if err != nil {
		return ProblemCoordinatorPin
	}
	if own, err := executableHash(self); err != nil || own != r.CoordinatorSHA256 {
		return ProblemCoordinatorPin
	}
	return ProblemInvalid
}

// decodeRegistry reads the file and decodes it without the full validation, so a registry whose
// pins went stale (a worker or node update) can still be reported and repinned.
func (m *RegistryManager) decode() (Registry, []byte, string) {
	if m.Path == "" {
		return Registry{}, nil, ProblemUnconfigured
	}
	raw, err := readRegistryRaw(m.Path)
	if err != nil {
		return Registry{}, nil, ProblemUnreadable
	}
	var r Registry
	if benchjournal.Decode(raw, &r) != nil || r.Version != RegistryVersion || r.NodeID != m.NodeID {
		return Registry{}, nil, ProblemMalformed
	}
	return r, raw, ""
}

// Status reports the installed registry, its pins, the bench daemon and every served profile.
func (m *RegistryManager) Status(ctx context.Context) RegistryStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status(ctx)
}

func (m *RegistryManager) status(ctx context.Context) RegistryStatus {
	out := RegistryStatus{Configured: m.Path != "", NodeID: m.NodeID, Profiles: []ProfileView{}}
	r, raw, problem := m.decode()
	if problem != "" {
		out.Problem = problem
		return out
	}
	out.HostID, out.WorkerSHA256, out.CoordinatorSHA256 = r.HostID, r.WorkerSHA256, r.CoordinatorSHA256
	if worker, err := executableHash(r.WorkerPath); err == nil {
		out.WorkerInstalledSHA256 = worker
	}
	if self, err := ownExecutable(); err == nil {
		if own, err := executableHash(self); err == nil {
			out.CoordinatorInstalledSHA256 = own
		}
	}
	out.Benchd = probeBenchd(ctx, r.Socket)
	parsed, digest, err := parseRegistry(raw, m.NodeID)
	if err != nil {
		out.Problem = diagnose(r)
		return out
	}
	out.Valid, out.RegistrySHA256 = true, digest
	for _, p := range parsed.Profiles {
		view := ProfileView{ID: p.ID, CheckpointRepository: p.CheckpointRepository, Launch: p.Launch, Target: parsed.target(p, digest),
			Repositories: make([]RepositoryView, 0, len(p.Repositories))}
		for _, repo := range p.Repositories {
			view.Repositories = append(view.Repositories, RepositoryView{Name: repo.Name, RepositorySHA256: rawSHA([]byte(repo.Repository)),
				ObjectFormat: repo.ObjectFormat, Base: repo.Base})
		}
		out.Profiles = append(out.Profiles, view)
	}
	return out
}

func probeBenchd(ctx context.Context, socket string) *BenchdView {
	view := &BenchdView{}
	client, err := benchworkspace.NewClient(socket, 5*time.Second)
	if err != nil {
		return view
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	reply, err := client.Do(ctx, benchworkspace.Request{Version: benchworkspace.Version, Operation: "host_status"})
	if err != nil || reply == nil {
		return view
	}
	view.Reachable = true
	if host, ok := reply.Result.(*benchworkspace.HostStatus); ok {
		view.Managed, view.DataFreeBytes, view.StateFreeBytes = host.Managed, host.DataFreeBytes, host.StateFreeBytes
	}
	return view
}

// Set adds or changes one profile, or only repins. Nothing is written unless the complete new
// file validates.
func (m *RegistryManager) Set(ctx context.Context, req SetRequest) (RegistryStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, _, problem := m.decode()
	if problem != "" {
		return RegistryStatus{}, &Refusal{Code: problem, Message: "the node's registry cannot be edited: " + problem}
	}
	if req.Profile == nil && !req.Repin {
		return RegistryStatus{}, &Refusal{Code: "empty", Message: "nothing to change"}
	}
	if req.Profile != nil {
		if err := applyChange(&r, *req.Profile); err != nil {
			return RegistryStatus{}, err
		}
	}
	if req.Repin {
		worker, err := executableHash(r.WorkerPath)
		if err != nil {
			return RegistryStatus{}, &Refusal{Code: ProblemWorkerPin, Message: "the installed worker cannot be hashed"}
		}
		self, err := ownExecutable()
		if err != nil {
			return RegistryStatus{}, &Refusal{Code: ProblemCoordinatorPin, Message: "this node binary cannot be hashed"}
		}
		own, err := executableHash(self)
		if err != nil {
			return RegistryStatus{}, &Refusal{Code: ProblemCoordinatorPin, Message: "this node binary cannot be hashed"}
		}
		r.WorkerSHA256, r.CoordinatorSHA256 = worker, own
	}
	return m.write(ctx, r)
}

// Remove deletes one profile by id.
func (m *RegistryManager) Remove(ctx context.Context, req RemoveRequest) (RegistryStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, _, problem := m.decode()
	if problem != "" {
		return RegistryStatus{}, &Refusal{Code: problem, Message: "the node's registry cannot be edited: " + problem}
	}
	kept := make([]LocalProfile, 0, len(r.Profiles))
	for _, p := range r.Profiles {
		if p.ID != req.ID {
			kept = append(kept, p)
		}
	}
	if len(kept) == len(r.Profiles) {
		return RegistryStatus{}, &Refusal{Code: "not_found", Message: "the node's registry has no profile with that id"}
	}
	r.Profiles = kept
	return m.write(ctx, r)
}

func (m *RegistryManager) write(ctx context.Context, r Registry) (RegistryStatus, error) {
	if r.Profiles == nil {
		r.Profiles = []LocalProfile{}
	}
	raw, err := json.Marshal(r)
	if err != nil || len(raw) > maxRegistryBytes {
		return RegistryStatus{}, &Refusal{Code: ProblemInvalid, Message: "the new registry is larger than the node reads"}
	}
	if _, _, err = parseRegistry(raw, m.NodeID); err != nil {
		// Named by the same diagnosis a status read gives, and nothing written.
		code := diagnose(r)
		return RegistryStatus{}, &Refusal{Code: code, Message: "the new registry would not validate (" + code + "); nothing was written"}
	}
	if err = benchjournal.WriteAtomic(filepath.Dir(m.Path), filepath.Base(m.Path), raw); err != nil {
		return RegistryStatus{}, &Refusal{Code: ProblemUnreadable, Message: "the registry could not be written; the installed file is unchanged"}
	}
	if m.Reload != nil {
		m.Reload()
	}
	return m.status(ctx), nil
}

func applyChange(r *Registry, c ProfileChange) error {
	if c.ID == "" || c.TenantID == "" || c.BoardID == "" || c.AgentID == "" || c.StationID == "" {
		return &Refusal{Code: "invalid_request", Message: "a profile change names its id, tenant, board, agent and station"}
	}
	index := -1
	for i, p := range r.Profiles {
		if p.ID == c.ID {
			index = i
		} else if p.TenantID == c.TenantID && p.BoardID == c.BoardID && p.StationID == c.StationID {
			return &Refusal{Code: "selector_taken", Message: "another profile already serves this board on this station"}
		}
	}
	var p LocalProfile
	if index >= 0 {
		p = r.Profiles[index]
	} else {
		if len(r.Profiles) >= MaxRegistryProfiles {
			return &Refusal{Code: "full", Message: "the node's registry already holds the most profiles it serves"}
		}
		remote := c.Launch != nil && *c.Launch == benchremote.Mode
		if c.CheckpointRepository == "" || len(c.Repositories) == 0 || len(c.Arguments) == 0 && !remote {
			return &Refusal{Code: "invalid_request", Message: "a new profile needs its repositories, checkpoint repository and worker arguments"}
		}
		p.Environment = map[string]string{}
	}
	p.ID, p.TenantID, p.BoardID, p.AgentID, p.StationID = c.ID, c.TenantID, c.BoardID, c.AgentID, c.StationID
	if c.CheckpointRepository != "" {
		p.CheckpointRepository = c.CheckpointRepository
	}
	if len(c.Repositories) > 0 {
		repos := append([]LocalRepository(nil), c.Repositories...)
		sort.Slice(repos, func(i, j int) bool { return repos[i].Name < repos[j].Name })
		p.Repositories = repos
	}
	if len(c.Arguments) > 0 {
		p.Arguments = append([]string(nil), c.Arguments...)
	}
	if c.Environment != nil {
		p.Environment = c.Environment
	}
	if c.Launch != nil {
		p.Launch = *c.Launch
	}
	if p.Launch == benchremote.Mode {
		// A remote stage runs no worker here. A stage switched from one-shot
		// on the same node keeps none of its old worker's arguments or
		// environment: the hub sends only the new launch.
		p.Arguments, p.Environment = []string{}, map[string]string{}
	}
	if index >= 0 {
		r.Profiles[index] = p
	} else {
		r.Profiles = append(r.Profiles, p)
	}
	return nil
}
