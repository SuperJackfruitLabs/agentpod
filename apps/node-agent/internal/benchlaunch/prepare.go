package benchlaunch

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcanonical"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchsource"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// StdoutLimit is one framed registered result: a BE32 length and its body.
const StdoutLimit = superbench.MaxWorker + 4

var digest = benchattempt.RawSHA256

// ordinary performs one plain v2 operation and parses its reply.
func (c Coordinator) ordinary(ctx context.Context, spec benchdispatch.SourceSpec, name string, r benchworkspace.Request, cleanup bool) (benchworkspace.Response, error) {
	raw, err := json.Marshal(r)
	if err != nil {
		return benchworkspace.Response{}, benchdispatch.ErrInvalid
	}
	if _, err = benchworkspace.Parse(raw); err != nil {
		return benchworkspace.Response{}, benchdispatch.ErrInvalid
	}
	k := call{name: name, path: benchworkspace.PathOperations, growth: benchworkspace.Growth(r.Operation), cleanup: cleanup, request: raw}
	if k.growth {
		lookup, e := benchworkspace.NewReceiptLookupRequest(r)
		if e != nil {
			return benchworkspace.Response{}, benchdispatch.ErrInvalid
		}
		k.lookup = &lookup
	}
	status, body, err := c.send(ctx, spec, k)
	if err != nil {
		return benchworkspace.Response{}, err
	}
	reply, err := benchworkspace.ParseResponse(body, status, r)
	if err != nil {
		return benchworkspace.Response{}, refuse("verification_failed")
	}
	return reply, nil
}

// refusalFor maps a definite producer refusal to the coordinator wire code.
func refusalFor(code string) string {
	switch code {
	case "capacity_exhausted":
		return "capacity_exhausted"
	case "conflict", "forbidden":
		return "stale_owner"
	case "invalid_request", "not_found":
		return "unsupported"
	}
	return "verification_failed"
}

func mutationOf(r benchworkspace.Response) *benchworkspace.Mutation {
	switch v := r.Result.(type) {
	case *benchworkspace.Mutation:
		return v
	case *benchworkspace.RunOutcome:
		return &v.Mutation
	case *benchworkspace.FiniteRunOutcome:
		return &v.Mutation
	}
	return nil
}

func heldBy(spec benchdispatch.SourceSpec, m *benchworkspace.Mutation) bool {
	if m == nil {
		return false
	}
	w := m.Workspace
	return w.Key == spec.BenchKey && w.Phase == "ready" && w.TransferState == "" && w.Pending == nil && w.Archive == nil && w.MemberCount == len(spec.Repositories) && w.CheckpointRepository == spec.CheckpointRepository && w.Lease != nil && w.Lease.Holder == spec.Holder && !w.Lease.StopRequested && (w.Lease.Execution == nil || w.Lease.Execution.Phase == "stopped")
}

// Prepare acquires the lease, observes the registration and binds the exact
// profiled run request. It launches nothing.
func (c Coordinator) Prepare(ctx context.Context, spec benchdispatch.SourceSpec, task benchdispatch.SourceTask) (benchcoordinator.Prepared, error) {
	var zero benchcoordinator.Prepared
	if !benchsource.ValidSpec(spec) || benchdispatch.SourceTaskSHA256(task) != spec.TaskSHA256 || len(c.Repositories) != len(spec.Repositories) {
		return zero, benchdispatch.ErrInvalid
	}
	for i, r := range c.Repositories {
		want := spec.Repositories[i]
		if r.Name != want.Name || digest([]byte(r.Repository)) != want.RepositorySHA256 || r.Branch != strings.TrimPrefix(want.TaskRef, "refs/heads/") || r.Base != want.Base {
			return zero, benchdispatch.ErrInvalid
		}
	}
	if err := c.current(ctx, spec); err != nil {
		return zero, err
	}
	if err := c.Journal.reserve(ctx, spec); err != nil {
		return zero, err
	}
	if r, _, err := c.Journal.read(ctx, spec); err != nil {
		return zero, err
	} else if r.Phase == phaseRefused {
		return zero, refuse(r.Code)
	} else if r.Binding != nil {
		return prepared(r)
	}
	operations := []benchattempt.SourceOperation{}
	observe := func(name string, request benchworkspace.Request, reply benchworkspace.Response) error {
		raw, _ := json.Marshal(request)
		body, _ := request.Digest()
		r, _, err := c.Journal.read(ctx, spec)
		s := r.step(name)
		if err != nil || s == nil {
			return benchdispatch.ErrInvalid
		}
		operations = append(operations, benchattempt.SourceOperation{Step: name, RequestSHA256: digest(raw), BodySHA256: body, ResponseSHA256: digest(s.Response), HTTPStatus: s.Status, Phase: "observed"})
		return nil
	}
	if spec.Create {
		yes := true
		request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "create", Key: spec.BenchKey, Repositories: c.Repositories, CheckpointRepository: spec.CheckpointRepository, Initialize: &yes, RequestID: spec.CreateRequestID}
		reply, err := c.ordinary(ctx, spec, "create", request, false)
		if err != nil {
			return zero, err
		}
		if !reply.OK {
			return zero, c.terminate(ctx, spec, refusalFor(reply.Error.Code), false)
		}
		m := mutationOf(reply)
		if m == nil || m.Workspace.Phase != "ready" || !m.Workspace.ReadyForAcquisition || m.Workspace.Lease != nil || m.RootPath != filepath.Join(spec.DataRoot, "benches", spec.BenchKey) {
			return zero, c.terminate(ctx, spec, "verification_failed", false)
		}
		if err = observe("create", request, reply); err != nil {
			return zero, err
		}
	}
	leaseRequest := benchworkspace.Request{Version: benchworkspace.Version, Operation: "lease", Key: spec.BenchKey, Holder: spec.Holder, RequestID: spec.LeaseRequestID}
	reply, err := c.ordinary(ctx, spec, "lease", leaseRequest, false)
	if err != nil {
		return zero, err
	}
	if !reply.OK {
		code := refusalFor(reply.Error.Code)
		if reply.Error.Code == "conflict" {
			code = "conflict" // another holder owns the bench
		}
		return zero, c.terminate(ctx, spec, code, false)
	}
	lease := mutationOf(reply)
	if !heldBy(spec, lease) || lease.Grant == nil || lease.RootPath != filepath.Join(spec.DataRoot, "benches", spec.BenchKey) {
		return zero, c.terminate(ctx, spec, "stale_owner", false)
	}
	if err = observe("lease", leaseRequest, reply); err != nil {
		return zero, err
	}
	token := lease.Grant.LeaseToken
	_ = c.mark(ctx, spec, func(r *record) bool { r.Release = "needed"; return true })
	cpRequest := benchworkspace.Request{Version: benchworkspace.Version, Operation: "checkpoint", Key: spec.BenchKey, LeaseToken: token}
	reply, err = c.ordinary(ctx, spec, "checkpoint", cpRequest, false)
	if err != nil {
		return zero, err
	}
	if !reply.OK {
		return zero, c.terminate(ctx, spec, refusalFor(reply.Error.Code), true)
	}
	cp := mutationOf(reply)
	if !heldBy(spec, cp) || cp.Workspace.BenchID != lease.Workspace.BenchID || cp.Workspace.Checkpoint == nil || len(cp.Workspace.Checkpoint.Members) != len(spec.Repositories) {
		return zero, c.terminate(ctx, spec, "verification_failed", true)
	}
	if err = observe("checkpoint", cpRequest, reply); err != nil {
		return zero, err
	}
	layout, err := c.observe(ctx, spec, lease, cp, token)
	if err != nil {
		return zero, err
	}
	return c.bind(ctx, spec, task, lease, cp, token, layout, operations)
}

// observe reads the registered physical layout under the lease we hold.
func (c Coordinator) observe(ctx context.Context, spec benchdispatch.SourceSpec, lease, cp *benchworkspace.Mutation, token string) (benchworkspace.RegistrationObservation, error) {
	var zero benchworkspace.RegistrationObservation
	request := benchworkspace.RegistrationObserveRequest{Version: benchworkspace.Version, Operation: "registration_observe", Key: spec.BenchKey, BenchID: lease.Workspace.BenchID, Holder: spec.Holder, LeaseToken: token}
	raw, err := request.Bytes()
	if err != nil {
		return zero, benchdispatch.ErrInvalid
	}
	status, body, err := c.send(ctx, spec, call{name: "observe", path: benchworkspace.PathRegistration, request: raw})
	if err != nil {
		return zero, err
	}
	reply, err := benchworkspace.ParseRegistrationObserveResponse(body, status, request)
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", true)
	}
	if !reply.OK {
		return zero, c.terminate(ctx, spec, refusalFor(reply.Error.Code), reply.Error.Code != "conflict" && reply.Error.Code != "forbidden")
	}
	o := *reply.Result
	want := cp.Workspace.Checkpoint
	if o.RootPath != lease.RootPath || o.Checkpoint.GenerationID != want.GenerationID || o.Checkpoint.Seal != want.Seal || o.Checkpoint.ManifestSHA256 != want.ManifestSHA256 || len(o.Members) != len(spec.Repositories) {
		return zero, c.terminate(ctx, spec, "verification_failed", true)
	}
	for i, m := range o.Checkpoint.Members {
		if m != want.Members[i] || o.Members[i].Name != spec.Repositories[i].Name {
			return zero, c.terminate(ctx, spec, "verification_failed", true)
		}
	}
	return o, nil
}

func node(n benchworkspace.RegistrationNode) superbench.RegisteredNode {
	return superbench.RegisteredNode{Device: n.Device, Inode: n.Inode}
}

// Frame returns the registered capsule's stdin frame and its body digest.
func Frame(capsule superbench.RegisteredCapsule) ([]byte, string, error) {
	body, err := capsule.Bytes()
	if err != nil {
		return nil, "", err
	}
	if len(body) > superbench.MaxWorker {
		return nil, "", superbench.ErrRegisteredFrame
	}
	n := len(body)
	frame := []byte{byte(n >> 24 & 255), byte(n >> 16 & 255), byte(n >> 8 & 255), byte(n & 255)}
	return append(frame, body...), digest(body), nil
}

func (c Coordinator) bind(ctx context.Context, spec benchdispatch.SourceSpec, task benchdispatch.SourceTask, lease, cp *benchworkspace.Mutation, token string, o benchworkspace.RegistrationObservation, operations []benchattempt.SourceOperation) (benchcoordinator.Prepared, error) {
	var zero benchcoordinator.Prepared
	members := make([]superbench.GroupedMember, 0, len(spec.Repositories))
	sources := make([]benchattempt.Source, 0, len(spec.Repositories))
	layout := superbench.RegisteredLayout{Key: o.Key, BenchID: o.BenchID, Version: o.LayoutVersion, PolicySHA256: o.PolicySHA256, Root: node(o.Root), RootHome: node(o.RootHome), RootTemp: node(o.RootTemp)}
	for i, repo := range spec.Repositories {
		commit := cp.Workspace.Checkpoint.Members[i].Commit
		if repo.ObjectFormat == "sha1" && len(commit) != 40 || repo.ObjectFormat == "sha256" && len(commit) != 64 {
			return zero, c.terminate(ctx, spec, "verification_failed", true)
		}
		members = append(members, superbench.GroupedMember{Name: repo.Name, RepositorySHA256: repo.RepositorySHA256, TaskRef: repo.TaskRef, ObjectFormat: repo.ObjectFormat, Commit: commit})
		sources = append(sources, benchattempt.Source{Name: repo.Name, RepositorySHA256: repo.RepositorySHA256, TaskRef: repo.TaskRef, Commit: commit})
		m := o.Members[i]
		layout.Members = append(layout.Members, superbench.RegisteredMember{Name: m.Name, Checkout: node(m.Checkout), Admin: node(m.Admin), Home: node(m.Home), Temp: node(m.Temp)})
	}
	binding := superbench.Binding{BoardID: spec.Identity.BoardID, CardID: spec.Identity.CardID, RunID: spec.Identity.RunID, Epoch: spec.Identity.Epoch}
	capsule := superbench.RegisteredCapsule{Version: superbench.RegisteredWorkerVersion, Layout: layout, Task: superbench.GroupedWorkerSpec{Version: superbench.GroupedWorkerVersion, Binding: binding, BenchKey: spec.BenchKey, BenchID: o.BenchID, WorkspaceRoot: o.RootPath, RepositoryName: task.RepositoryName, Members: members, Arguments: task.Arguments, Prompt: task.Prompt, Environment: task.Environment, TimeoutSeconds: task.TimeoutSeconds}}
	frame, capsuleSHA, err := Frame(capsule)
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", true)
	}
	run := benchworkspace.Request{Version: benchworkspace.Version, Operation: "run", Key: spec.BenchKey, Holder: spec.Holder, RequestID: spec.RunRequestID, LeaseToken: token, Arguments: []string{spec.WorkerPath, Mode, capsuleSHA}}
	finite, err := benchworkspace.NewFiniteRun(run, frame, StdoutLimit)
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", true)
	}
	raw, _ := finite.Bytes()
	typed, _ := finite.Digest()
	source, err := benchcanonical.Digest(raw)
	if err != nil {
		return zero, c.terminate(ctx, spec, "verification_failed", true)
	}
	b := benchdispatch.SourceBinding{Identity: spec.Identity, HostID: spec.HostID, BenchKey: spec.BenchKey, BenchID: o.BenchID, Sources: sources, Members: members, Checkpoint: *cp.Workspace.Checkpoint, Operations: operations, RequestSHA256: digest(raw), BodySHA256: typed, ContextSHA256: capsuleSHA, WorkerSHA256: spec.WorkerSHA256}
	var out record
	err = c.Journal.withRecord(ctx, spec, func(r *record, active bool) (bool, error) {
		if r.Binding != nil {
			out = *r
			return false, nil
		}
		if !active || r.Cancelled || r.Phase != phaseReserved || c.current(ctx, spec) != nil {
			return false, refuse("stale_owner")
		}
		r.Steps = append(r.Steps, step{Name: "run", Request: raw})
		r.Binding, r.Capsule, r.SourceSHA, r.Phase = &b, capsuleSHA, source, phasePrepared
		out = *r
		return true, nil
	})
	if err != nil {
		return zero, err
	}
	return prepared(out)
}

func prepared(r record) (benchcoordinator.Prepared, error) {
	if r.Binding == nil {
		return benchcoordinator.Prepared{}, benchdispatch.ErrPending
	}
	return benchcoordinator.Prepared{Binding: *r.Binding, BindingSHA256: benchdispatch.SourceBindingSHA256(*r.Binding), RequestID: r.Spec.RunRequestID, CheckpointRepository: r.Spec.CheckpointRepository, SourceRequestSHA256: r.SourceSHA}, nil
}
