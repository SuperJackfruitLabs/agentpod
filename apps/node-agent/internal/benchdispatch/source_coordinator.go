package benchdispatch

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// SourceTask is private task input. Its digest is frozen before any acquisition;
// its prompt/arguments/environment never enter ordinary reservation JSON.
type SourceTask struct {
	Arguments      []string          `json:"arguments"`
	Prompt         string            `json:"prompt"`
	Environment    map[string]string `json:"environment"`
	TimeoutSeconds uint32            `json:"timeout_seconds"`
	RepositoryName string            `json:"repository_name,omitempty"`
}

func SourceTaskSHA256(task SourceTask) string { raw, _ := json.Marshal(task); return digest(raw) }

// SourceCoordinator performs real host-local client operations; it cannot
// authorize itself. Current must be the selected trusted owner/registry/control
// check. No production route, node verb or grant enables this private path.
// Preparation stops at immutable source binding: launching still requires the
// separate current-run admission and protected Dispatch gate.
type SourceCoordinator struct {
	Store         Store
	Client        *benchworkspace.Client
	Repositories  []benchworkspace.Repository
	ContextParent string
	Current       SourceGate
}

func (c SourceCoordinator) operation(ctx context.Context, spec SourceSpec, step string, request benchworkspace.Request) (*benchworkspace.Response, error) {
	if reply, err := c.Store.SourceReply(ctx, spec, step); err == nil {
		if !reply.OK {
			return nil, ErrPending
		}
		return reply, nil
	}
	send, err := c.Store.BeginSourceOperation(ctx, spec, step, request, c.Current)
	if err != nil {
		return nil, err
	}
	if send {
		_, evidence, _ := c.Client.DoWithEvidence(ctx, request)
		// Preserve an actual reply even when cancellation arrived during transport.
		// This independent context only journals evidence; it never sends a request.
		persist, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err = c.Store.ObserveSourceOperation(persist, spec, step, evidence)
		cancel()
	} else {
		err = c.Store.ObserveSourceOperation(ctx, spec, step, nil)
	}
	if err != nil {
		return nil, ErrPending
	}
	if ctx.Err() != nil {
		return nil, ErrPending
	}
	reply, err := c.Store.SourceReply(ctx, spec, step)
	if err != nil || !reply.OK {
		return nil, ErrPending
	}
	if c.Current(ctx, spec) != nil || ctx.Err() != nil {
		return nil, ErrOwner
	}
	return reply, nil
}

// Prepare reserves before create/lease, prepares through the actual lease
// operation, checkpoints retaining that exact token, constructs the protected
// context from parsed receipts, then atomically binds the complete launch plan.
// No payload, ACP process, source admission or board mutation occurs here.
func (c SourceCoordinator) Prepare(ctx context.Context, spec SourceSpec, task SourceTask) (Plan, error) {
	var zero Plan
	if c.Client == nil || c.Current == nil || !validSourceSpec(spec) || SourceTaskSHA256(task) != spec.TaskSHA256 || !validSourceTask(task) || c.ContextParent != spec.ContextParent || physicalDir(c.ContextParent, true) != nil || physicalDir(spec.DataRoot, false) != nil || len(c.Repositories) != len(spec.Repositories) {
		return zero, ErrInvalid
	}
	real, err := filepath.EvalSymlinks(spec.WorkerPath)
	if err != nil || real != spec.WorkerPath {
		return zero, ErrInvalid
	}
	worker, err := readFile(spec.WorkerPath, 64<<20, false)
	if err != nil || digest(worker) != spec.WorkerSHA256 {
		return zero, ErrInvalid
	}
	for i, r := range c.Repositories {
		want := spec.Repositories[i]
		if r.Name != want.Name || digest([]byte(r.Repository)) != want.RepositorySHA256 || r.Branch != strings.TrimPrefix(want.TaskRef, "refs/heads/") || r.Base != want.Base {
			return zero, ErrInvalid
		}
	}
	if err = c.Store.ReserveSource(ctx, spec, c.Current); err != nil {
		return zero, err
	}
	if spec.Create {
		yes := true
		r := benchworkspace.Request{Version: benchworkspace.Version, Operation: "create", Key: spec.BenchKey, Repositories: c.Repositories, CheckpointRepository: spec.CheckpointRepository, Initialize: &yes, RequestID: spec.CreateRequestID}
		created, e := c.operation(ctx, spec, "create", r)
		if e != nil {
			return zero, e
		}
		m := sourceMutation(created)
		if m == nil || m.Workspace.Phase != "ready" || !m.Workspace.ReadyForAcquisition || m.Workspace.Lease != nil || m.Workspace.Pending != nil || m.Workspace.TransferState != "" || m.RootPath != filepath.Join(spec.DataRoot, "benches", spec.BenchKey) {
			return zero, ErrVerify
		}
	}
	lease, err := c.operation(ctx, spec, "lease", benchworkspace.Request{Version: benchworkspace.Version, Operation: "lease", Key: spec.BenchKey, Holder: spec.Holder, RequestID: spec.LeaseRequestID})
	if err != nil {
		return zero, err
	}
	owned := sourceMutation(lease)
	if !validHeldSource(spec, owned) || owned.Grant == nil || owned.RootPath != filepath.Join(spec.DataRoot, "benches", spec.BenchKey) {
		return zero, ErrVerify
	}
	if _, err = c.operation(ctx, spec, "checkpoint", benchworkspace.Request{Version: benchworkspace.Version, Operation: "checkpoint", Key: spec.BenchKey, LeaseToken: owned.Grant.LeaseToken}); err != nil {
		return zero, err
	}
	cp, members, err := c.Store.SourceCheckpoint(ctx, spec)
	if err != nil {
		return zero, err
	}
	binding := superbench.Binding{BoardID: spec.Identity.BoardID, CardID: spec.Identity.CardID, RunID: spec.Identity.RunID, Epoch: spec.Identity.Epoch}
	dir, hash, err := superbench.PrepareGroupedWorker(c.ContextParent, superbench.GroupedWorkerSpec{Version: superbench.GroupedWorkerVersion, Binding: binding, BenchKey: spec.BenchKey, BenchID: cp.Workspace.BenchID, WorkspaceRoot: cp.RootPath, RepositoryName: task.RepositoryName, Members: members, Arguments: task.Arguments, Prompt: task.Prompt, Environment: task.Environment, TimeoutSeconds: task.TimeoutSeconds})
	if err != nil {
		return zero, ErrInvalid
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "run", Key: spec.BenchKey, Holder: spec.Holder, LeaseToken: owned.Grant.LeaseToken, RequestID: spec.RunRequestID, Arguments: []string{spec.WorkerPath, dir, hash}}
	raw, err := json.Marshal(request)
	if err != nil {
		return zero, ErrInvalid
	}
	body, err := request.Digest()
	if err != nil {
		return zero, ErrInvalid
	}
	p := Plan{Identity: spec.Identity, Grouped: &GroupedLaunch{WorkspaceRoot: cp.RootPath, RepositoryName: task.RepositoryName, Members: members}, HostID: spec.HostID, BenchKey: spec.BenchKey, RegistrationID: cp.Workspace.BenchID, Holder: spec.Holder, RequestID: spec.RunRequestID, RequestSHA256: digest(raw), BodySHA256: body, ContextPath: dir, ContextSHA256: hash, ExecutablePath: spec.WorkerPath, ExecutableSHA256: spec.WorkerSHA256}
	for _, m := range members {
		p.Sources = append(p.Sources, Source{Name: m.Name, RepositorySHA256: m.RepositorySHA256, TaskRef: m.TaskRef, Commit: m.Commit})
	}
	if err = c.Store.BindSource(ctx, spec, p, raw, c.Current); err != nil {
		return zero, err
	}
	return p, nil
}

// BoundSource is an exact local lost-reply lookup, not a fresh grant. Only the
// still-active, not-launched bound attempt is returned; historical/superseded
// records never revive an owner or expose a continuation capability.
func (s Store) BoundSource(ctx context.Context, spec SourceSpec) (Plan, error) {
	var result Plan
	if !validSourceSpec(spec) {
		return result, ErrInvalid
	}
	err := s.withDocument(ctx, spec.BenchKey, false, func(doc *state) (bool, error) {
		for _, r := range doc.Records {
			if r.Source != nil && sourceDigest(r.Source.Spec) == sourceDigest(spec) {
				if doc.Active != planID(r.Plan) || r.Phase != "prepared" {
					return false, ErrPending
				}
				if e := s.boundSourceEvidence(&r); e != nil {
					return false, e
				}
				raw, _ := json.Marshal(r.Plan)
				if json.Unmarshal(raw, &result) != nil {
					return false, ErrInvalid
				}
				return false, nil
			}
		}
		return false, ErrPending
	})
	return result, err
}

func validSourceTask(t SourceTask) bool {
	raw, e := json.Marshal(t)
	if e != nil || len(raw) > superbench.MaxWorker/2 || t.Environment == nil || len(t.Arguments) == 0 || len(t.Arguments) > 128 || !physicalName(t.Arguments[0]) || t.TimeoutSeconds == 0 || t.TimeoutSeconds > 3600 {
		return false
	}
	for _, a := range t.Arguments {
		if strings.ContainsRune(a, 0) || len(a) > 8192 {
			return false
		}
	}
	for k, v := range t.Environment {
		switch k {
		case "PATH", "LANG", "LC_ALL", "TZ", "TERM":
		default:
			return false
		}
		if strings.ContainsAny(v, "\x00\r\n") {
			return false
		}
	}
	return true
}
