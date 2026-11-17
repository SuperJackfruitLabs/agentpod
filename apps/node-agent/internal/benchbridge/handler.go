package benchbridge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// Handler is an explicitly constructed proposed dedicated port. Construction
// does not advertise readiness, install a registry or enable any board policy.
type Handler struct {
	registryPath string
	registry     Registry
	registrySHA  string
	current      *HubCurrent
	client       *benchworkspace.Client
}

func NewHandler(registryPath, hub, nodeID, nodeSecret string) (*Handler, error) {
	r, digest, err := readRegistry(registryPath, nodeID)
	if err != nil {
		return nil, ErrRegistry
	}
	current, err := NewHubCurrent(hub, nodeID, nodeSecret)
	if err != nil {
		return nil, ErrRegistry
	}
	client, err := benchworkspace.NewClient(r.Socket, time.Hour)
	if err != nil {
		return nil, ErrRegistry
	}
	return &Handler{registryPath: registryPath, registry: r, registrySHA: digest, current: current, client: client}, nil
}
func (h *Handler) Close() { h.client.Close() }
func (h *Handler) installed() error {
	r, digest, err := readRegistry(h.registryPath, h.registry.NodeID)
	if err != nil || digest != h.registrySHA || !reflect.DeepEqual(r, h.registry) {
		return ErrRegistry
	}
	return nil
}
func (h *Handler) profile(r benchcoordinatorwire.Request) (LocalProfile, error) {
	for _, p := range h.registry.Profiles {
		t := h.registry.target(p, h.registrySHA)
		if r.Operation == "ready" {
			if p.TenantID == r.TenantID && p.BoardID == r.BoardID && p.StationID == r.StationID {
				return p, nil
			}
		} else if r.Target != nil && *r.Target == t && (r.Task == nil || r.Task.ProfileID == p.ID) {
			return p, nil
		}
	}
	return LocalProfile{}, ErrRegistry
}
func (h *Handler) check(ctx context.Context, r benchcoordinatorwire.Request, p LocalProfile, intent Intent, phase string) error {
	if h.installed() != nil || r.Identity == nil || r.Target == nil {
		return ErrCurrent
	}
	current := benchcoordinatorwire.CurrentRequest{Phase: phase, Identity: *r.Identity, Target: *r.Target, ProfileID: p.ID, PrepareRequestSHA256: intent.PrepareSHA256}
	if phase == "execute" {
		if r.SourceReceipt == nil {
			return ErrCurrent
		}
		current.ExecuteRequestSHA256 = rawSHA([]byte(intent.ExecuteRequest))
		current.BindingSHA256 = r.BindingSHA256
		current.SourceDigest = r.SourceReceipt.SourceDigest
	}
	if err := h.current.Check(ctx, current); err != nil {
		return ErrCurrent
	}
	if h.installed() != nil {
		return ErrCurrent
	}
	return nil
}
func taskTimeout(value uint64) (uint32, error) {
	if value < 1 || value > 3600 {
		return 0, ErrIntent
	}
	return uint32(value), nil
}

func (h *Handler) choose(ctx context.Context, r benchcoordinatorwire.Request, p LocalProfile) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
	var zero benchdispatch.SourceSpec
	if r.Identity == nil || r.Task == nil {
		return zero, benchdispatch.SourceTask{}, ErrIntent
	}
	timeout, err := taskTimeout(r.Task.TimeoutSeconds)
	if err != nil {
		return zero, benchdispatch.SourceTask{}, err
	}
	identity := benchdispatch.Identity(*r.Identity)
	stable, _ := json.Marshal([]string{identity.TenantID, identity.BoardID, identity.CardID})
	key := "cp_" + rawSHA(stable)
	reply, err := h.client.Do(ctx, benchworkspace.Request{Version: benchworkspace.Version, Operation: "status", Key: key})
	if err != nil || reply == nil {
		return zero, benchdispatch.SourceTask{}, ErrIntent
	}
	inventory, ok := reply.Result.(*benchworkspace.Status)
	if !ok {
		return zero, benchdispatch.SourceTask{}, ErrIntent
	}
	create := true
	for _, entry := range inventory.Benches {
		switch entry := entry.(type) {
		case *benchworkspace.WorkspaceInventory:
			if entry.Key == key {
				if !create {
					return zero, benchdispatch.SourceTask{}, ErrIntent
				}
				create = false
			}
		case *benchworkspace.ScalarInventory:
			if entry.Key == key {
				return zero, benchdispatch.SourceTask{}, ErrIntent
			}
		default:
			return zero, benchdispatch.SourceTask{}, ErrIntent
		}
	}
	task := benchdispatch.SourceTask{Arguments: append([]string(nil), p.Arguments...), Environment: map[string]string{}, Prompt: r.Task.Prompt,
		TimeoutSeconds: timeout, RepositoryName: r.Task.RepositoryName}
	for k, v := range p.Environment {
		task.Environment[k] = v
	}
	id := intentName(*r.Identity)
	spec := benchdispatch.SourceSpec{Identity: identity, HostID: h.registry.HostID, BenchKey: key, Holder: "cp_" + id,
		ContextParent: h.registry.ContextParent, DataRoot: h.registry.DataRoot, CheckpointRepository: p.CheckpointRepository,
		WorkerPath: h.registry.WorkerPath, WorkerSHA256: h.registry.WorkerSHA256, TaskSHA256: benchdispatch.SourceTaskSHA256(task),
		Create: create, LeaseRequestID: "lease_" + id, RunRequestID: "run_" + id}
	if create {
		spec.CreateRequestID = "create_" + id
	}
	for _, repo := range p.Repositories {
		spec.Repositories = append(spec.Repositories, benchdispatch.SourceRepository{Name: repo.Name,
			RepositorySHA256: rawSHA([]byte(repo.Repository)), TaskRef: "refs/heads/card/" + identity.CardID, Base: repo.Base, ObjectFormat: repo.ObjectFormat})
	}
	return spec, task, nil
}

// coordinator is the attempt lifecycle the handler drives. The grouped
// context launch and the registered stdin launch both implement it.
type coordinator interface {
	Prepare(context.Context, benchdispatch.SourceSpec, benchdispatch.SourceTask) (benchcoordinator.Prepared, error)
	Execute(context.Context, benchdispatch.SourceSpec, benchdispatch.AdmissionGate) (benchcoordinator.Completion, error)
	Status(context.Context, benchdispatch.SourceSpec) (benchcoordinator.Status, error)
	Reserved(context.Context, benchdispatch.SourceSpec) (benchdispatch.SourceSpec, error)
}

type groupedCoordinator struct{ benchcoordinator.Manager }

func (g groupedCoordinator) Reserved(ctx context.Context, spec benchdispatch.SourceSpec) (benchdispatch.SourceSpec, error) {
	return g.Source.Store.ReservedSourceSpec(ctx, spec.BenchKey, spec.Identity)
}

func (h *Handler) manager(r benchcoordinatorwire.Request, p LocalProfile, intent Intent, phase string) coordinator {
	var repositories []benchworkspace.Repository
	for _, repo := range p.Repositories {
		repositories = append(repositories, benchworkspace.Repository{Name: repo.Name, Repository: repo.Repository, Base: repo.Base, Branch: "card/" + r.Identity.CardID})
	}
	current := func(ctx context.Context, spec benchdispatch.SourceSpec) error {
		if intent.Spec == nil || !reflect.DeepEqual(spec, *intent.Spec) {
			return ErrCurrent
		}
		return h.check(ctx, r, p, intent, phase)
	}
	if p.Launch == benchlaunch.Mode {
		// A private sibling of the grouped journal; Journal refuses it unless 0700.
		root := filepath.Join(h.registry.StateRoot, "registered")
		_ = os.Mkdir(root, 0700)
		return benchlaunch.Coordinator{Journal: benchlaunch.Journal{Root: root}, Producer: h.client, Repositories: repositories, Current: current}
	}
	source := benchdispatch.SourceCoordinator{Store: benchdispatch.Store{Root: h.registry.StateRoot}, Client: h.client, ContextParent: h.registry.ContextParent, Repositories: repositories, Current: current}
	return groupedCoordinator{benchcoordinator.Manager{Source: source}}
}

// failed keeps unknown outcomes parked. Only a terminal refusal from the
// registered launch is reported, with its own code.
func failed(r benchcoordinatorwire.Request, err error) (benchcoordinatorwire.Response, error) {
	if code, ok := benchlaunch.RefusalCode(err); ok {
		response := refused(r.Operation)
		response.Code = code
		return response, nil
	}
	return pending(r), err
}
func pending(r benchcoordinatorwire.Request) benchcoordinatorwire.Response {
	return benchcoordinatorwire.Response{Version: benchcoordinatorwire.Version, Operation: r.Operation, State: "pending", Identity: r.Identity, Target: r.Target}
}
func refused(operation string) benchcoordinatorwire.Response {
	return benchcoordinatorwire.Response{Version: benchcoordinatorwire.Version, Operation: operation, State: "refused", Code: "unavailable"}
}
func preparedResponse(r benchcoordinatorwire.Request, value benchcoordinator.Prepared) (benchcoordinatorwire.Response, error) {
	raw, err := json.Marshal(value)
	var prepared benchcoordinatorwire.Prepared
	if err != nil || json.Unmarshal(raw, &prepared) != nil {
		return refused(r.Operation), ErrIntent
	}
	response := pending(r)
	response.State = "prepared"
	response.Source = &prepared
	return checkedResponse(r, response)
}
func completedResponse(r benchcoordinatorwire.Request, spec benchdispatch.SourceSpec, value benchcoordinator.Completion) (benchcoordinatorwire.Response, error) {
	// The private Completion contains a bare SourceBinding; public source fields
	// are supplied only from the exact reserved spec and canonical saved bytes.
	prepared := benchcoordinator.Prepared{Binding: value.Source, BindingSHA256: benchdispatch.SourceBindingSHA256(value.Source), RequestID: spec.RunRequestID,
		CheckpointRepository: spec.CheckpointRepository, SourceRequestSHA256: value.SourceRequestSHA256}
	raw, err := json.Marshal(struct {
		Source     benchcoordinator.Prepared `json:"source"`
		Service    benchdispatch.Observation `json:"service"`
		Task       any                       `json:"task"`
		RequestSHA string                    `json:"source_request_sha256"`
		ReceiptSHA string                    `json:"source_receipt_sha256"`
	}{prepared, value.Service, value.Task, value.SourceRequestSHA256, value.SourceReceiptSHA256})
	var completion benchcoordinatorwire.Completion
	if err != nil || json.Unmarshal(raw, &completion) != nil {
		return refused(r.Operation), ErrIntent
	}
	response := pending(r)
	response.State = "completed"
	response.Completion = &completion
	return checkedResponse(r, response)
}
func checkedResponse(r benchcoordinatorwire.Request, response benchcoordinatorwire.Response) (benchcoordinatorwire.Response, error) {
	raw, err := json.Marshal(response)
	if err != nil {
		return refused(r.Operation), ErrIntent
	}
	parsed, err := benchcoordinatorwire.ParseResponse(raw, r)
	if err != nil {
		return refused(r.Operation), ErrIntent
	}
	return parsed, nil
}

// Handle never forwards filesystem errors/private evidence or falls back to ACP.
// Unknown outcomes remain parked under the original exact attempt.
func (h *Handler) Handle(ctx context.Context, verb string, raw json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
	if verb != benchcoordinatorwire.Verb {
		return nil, false, errors.New("unsupported dedicated coordinator verb")
	}
	r, err := benchcoordinatorwire.ParseRequest(raw)
	if err != nil {
		return nil, false, errors.New("invalid dedicated coordinator request")
	}
	response, err := h.handle(ctx, r, raw)
	return transportOutcome(r, response, err), false, nil
}

// transportOutcome never exports internal error text. An explicitly parked
// outcome stays pending; every other internal failure becomes a closed refusal.
func transportOutcome(r benchcoordinatorwire.Request, response benchcoordinatorwire.Response, err error) benchcoordinatorwire.Response {
	if err != nil && response.State != "pending" {
		return refused(r.Operation)
	}
	return response
}
func (h *Handler) handle(ctx context.Context, r benchcoordinatorwire.Request, raw []byte) (benchcoordinatorwire.Response, error) {
	if h.installed() != nil || managed(ctx, h.client) != nil {
		return refused(r.Operation), ErrRegistry
	}
	p, err := h.profile(r)
	if err != nil {
		return refused(r.Operation), err
	}
	if r.Operation == "ready" {
		target := h.registry.target(p, h.registrySHA)
		return checkedResponse(r, benchcoordinatorwire.Response{Version: benchcoordinatorwire.Version, Operation: "ready", State: "available", Target: &target})
	}
	intents := IntentStore{Root: h.registry.IntentRoot}
	if r.Operation == "prepare" {
		// The authenticated Hub reservation and current decision precede even the
		// private intent. No missing/corrupt source journal grants Create permission.
		initial := Intent{PrepareSHA256: rawSHA(raw)}
		if h.check(ctx, r, p, initial, "prepare") != nil {
			return refused(r.Operation), ErrCurrent
		}
		intent, err := intents.Resolve(ctx, raw, func(ctx context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
			if h.check(ctx, r, p, initial, "prepare") != nil {
				return benchdispatch.SourceSpec{}, benchdispatch.SourceTask{}, ErrCurrent
			}
			return h.choose(ctx, r, p)
		})
		if err != nil {
			return pending(r), err
		}
		send, err := intents.ClaimEffects(ctx, raw)
		if err != nil {
			return pending(r), err
		}
		m := h.manager(r, p, intent, "prepare")
		if send {
			source, err := m.Prepare(ctx, *intent.Spec, *intent.Task)
			if err != nil {
				return failed(r, err)
			}
			return preparedResponse(r, source)
		}
		return h.status(ctx, r, p, intent)
	}
	intent, err := intents.Read(ctx, r)
	if err != nil || intent.Spec == nil {
		return pending(r), ErrIntent
	}
	if r.Operation == "status" {
		return h.status(ctx, r, p, intent)
	}
	// Status and retries require the exact persisted source registration. An
	// interrupted handoff before registration stays pending rather than regrowing.
	prospective := intent
	prospective.ExecuteRequest = string(raw)
	prospective.ExecuteSHA256 = rawSHA(raw)
	if h.check(ctx, r, p, prospective, "execute") != nil {
		return refused(r.Operation), ErrCurrent
	}
	saved, err := h.manager(r, p, intent, "execute").Reserved(ctx, *intent.Spec)
	if err != nil || !reflect.DeepEqual(saved, *intent.Spec) {
		return pending(r), ErrIntent
	}
	send, err := intents.ClaimExecution(ctx, raw)
	if err != nil {
		return pending(r), err
	}
	intent, err = intents.Read(ctx, r)
	if err != nil {
		return pending(r), err
	}
	if !send {
		return h.status(ctx, r, p, intent)
	}
	m := h.manager(r, p, intent, "execute")
	completion, err := m.Execute(ctx, saved, func(ctx context.Context, b benchdispatch.SourceBinding) error {
		if benchdispatch.SourceBindingSHA256(b) != r.BindingSHA256 {
			return ErrCurrent
		}
		return h.check(ctx, r, p, intent, "execute")
	})
	if err != nil {
		return failed(r, err)
	}
	return completedResponse(r, saved, completion)
}
func (h *Handler) status(ctx context.Context, r benchcoordinatorwire.Request, p LocalProfile, intent Intent) (benchcoordinatorwire.Response, error) {
	if intent.Spec == nil || h.check(ctx, r, p, intent, "observe") != nil {
		return refused(r.Operation), ErrCurrent
	}
	m := h.manager(r, p, intent, "observe")
	saved, err := m.Reserved(ctx, *intent.Spec)
	if err != nil || !reflect.DeepEqual(saved, *intent.Spec) {
		if err == nil {
			err = ErrIntent
		}
		return failed(r, err)
	}
	status, err := m.Status(ctx, saved)
	if err != nil {
		return failed(r, err)
	}
	if status.State == "completed" && status.Completion != nil && r.Operation != "prepare" {
		return completedResponse(r, saved, *status.Completion)
	}
	if status.State == "prepared" && status.Source != nil && r.Operation != "execute" {
		return preparedResponse(r, *status.Source)
	}
	return pending(r), nil
}
