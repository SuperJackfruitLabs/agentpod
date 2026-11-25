package benchbridge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchremote"
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

// RegistrySHA256 is the digest of the registry bytes this handler serves: every target it
// advertises carries it as `registry_sha256`.
func (h *Handler) RegistrySHA256() string { return h.registrySHA }
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
		// An execute names its admitted source receipt; a remote attach or
		// finish has none of its own and names only its binding and bytes.
		remote := r.Operation == "attach" || r.Operation == "finish"
		if r.SourceReceipt == nil && !remote || intent.ExecuteRequest == "" {
			return ErrCurrent
		}
		current.ExecuteRequestSHA256 = rawSHA([]byte(intent.ExecuteRequest))
		current.BindingSHA256 = r.BindingSHA256
		if r.SourceReceipt != nil {
			current.SourceDigest = r.SourceReceipt.SourceDigest
		}
	}
	if err := h.current.Check(ctx, current); err != nil {
		if errors.Is(err, ErrStale) && h.installed() == nil {
			return ErrStale
		}
		return ErrCurrent
	}
	if h.installed() != nil {
		return ErrCurrent
	}
	return nil
}

// ErrReclaiming parks a prepare while SuperBench is still reclaiming the bench.
var ErrReclaiming = errors.New("bench is being reclaimed; retry later")

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
	p, err = selected(p, r.Task)
	if err != nil {
		return zero, benchdispatch.SourceTask{}, err
	}
	identity := benchdispatch.Identity(*r.Identity)
	stable, _ := json.Marshal([]string{identity.TenantID, identity.BoardID, identity.CardID})
	key := "cp_" + rawSHA(stable)
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "status", Key: key}
	reply, err := h.client.Do(ctx, request)
	// A specific-key status answers that key's record or not_found: a card's
	// first attempt finds no bench and creates it. Any other failure,
	// unavailable included, proves nothing and leaves the prepare pending.
	inventory := &benchworkspace.Status{}
	if reply == nil || !benchworkspace.KeyAbsent(request, *reply) {
		if err != nil || reply == nil {
			return zero, benchdispatch.SourceTask{}, ErrIntent
		}
		var ok bool
		if inventory, ok = reply.Result.(*benchworkspace.Status); !ok {
			return zero, benchdispatch.SourceTask{}, ErrIntent
		}
	}
	create, seen := true, false
	for _, entry := range inventory.Benches {
		switch entry := entry.(type) {
		case *benchworkspace.WorkspaceInventory:
			if entry.Key == key {
				if seen {
					return zero, benchdispatch.SourceTask{}, ErrIntent
				}
				seen = true
				// SuperBench reclaims a released, idle bench by itself. While
				// it is reclaiming nothing is chosen: the prepare stays
				// pending and is retried. Once reclaimed the bench is gone and
				// a create for the same key makes a fresh one from the card's
				// pushed branch.
				//
				// A registered bench stuck before ready (its create never
				// finished) is also a create, with this attempt's own request
				// ID: the registered launch stops an initialization owner it
				// holds and SuperBench makes the key's next generation, or
				// refuses and the attempt parks. The grouped launch leases.
				//
				// Any other phase is a bench that exists: its repositories and
				// start were fixed when it was created, so a different choice
				// is refused, named, never leased or recreated around.
				if entry.Phase != "reclaiming" && entry.Phase != "reclaimed" {
					if err := sameBench(entry, p); err != nil {
						return zero, benchdispatch.SourceTask{}, err
					}
				}
				switch entry.Phase {
				case "reclaiming":
					return zero, benchdispatch.SourceTask{}, ErrReclaiming
				case "reclaimed":
				case "materializing", "initializing":
					create = p.Launch == benchlaunch.Mode || p.Launch == benchremote.Mode
				default:
					create = false
				}
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

// prepareResumes says whether a prepare drives the launch's Prepare: the one
// call that claimed the effects, or any identical prepare of a registered
// launch, whose journaled steps make a repeat a resume (see handle).
func prepareResumes(claimed bool, p LocalProfile) bool {
	return claimed || journaled(p)
}

// journaled is a launch whose every step is journaled before it leaves: the
// registered launch and the remote launch built on its steps.
func journaled(p LocalProfile) bool {
	return p.Launch == benchlaunch.Mode || p.Launch == benchremote.Mode
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
	// The registry holds the stage's whole allow-list; the attempt's spec
	// names the members it was prepared with. A repository the spec does not
	// name is not passed on, so a coordinator never sees more than the card chose.
	for _, repo := range attemptRepositories(p, intent.Spec) {
		repositories = append(repositories, benchworkspace.Repository{Name: repo.Name, Repository: repo.Repository, Base: repo.Base, Branch: "card/" + r.Identity.CardID})
	}
	current := func(ctx context.Context, spec benchdispatch.SourceSpec) error {
		if intent.Spec == nil || !reflect.DeepEqual(spec, *intent.Spec) {
			return ErrCurrent
		}
		if err := h.check(ctx, r, p, intent, phase); errors.Is(err, ErrStale) {
			return benchlaunch.ErrSuperseded
		} else if err != nil {
			return ErrCurrent
		}
		return nil
	}
	if p.Launch == benchremote.Mode {
		// Its own private journal beside the registered one, also 0700.
		root := benchremote.JournalRoot(h.registry.StateRoot)
		_ = os.Mkdir(root, 0700)
		return benchremote.Coordinator{Journal: benchremote.Journal{Root: root}, Producer: h.client, Client: h.client, Repositories: repositories, Current: current}
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
		response.Detail = detail(benchlaunch.RefusalMessage(err), benchlaunch.RefusalLeaseHeld(err))
		if task := benchlaunch.RefusalTask(err); task != "" {
			if response.Detail == nil {
				response.Detail = &benchcoordinatorwire.Detail{}
			}
			response.Detail.Task = task
		}
		return response, nil
	}
	response := pending(r)
	if message, ok := benchlaunch.HeldLeaseOf(err); ok {
		response.Detail = detail(message, true)
	}
	return response, err
}

// detail is the reply's account of why, or nil when there is nothing to say.
func detail(message string, leaseHeld bool) *benchcoordinatorwire.Detail {
	if message == "" && !leaseHeld {
		return nil
	}
	d := &benchcoordinatorwire.Detail{Message: message}
	if leaseHeld {
		d.Lease = "held"
	}
	return d
}
func pending(r benchcoordinatorwire.Request) benchcoordinatorwire.Response {
	return benchcoordinatorwire.Response{Version: benchcoordinatorwire.Version, Operation: r.Operation, State: "pending", Identity: r.Identity, Target: r.Target}
}

// unresolved is the wire's "unknown": this node holds the attempt's exact
// prepare but chose nothing and invoked no source effect for it, so it holds
// nothing. It is the one status that lets the hub re-send that same prepare.
func unresolved(r benchcoordinatorwire.Request) (benchcoordinatorwire.Response, error) {
	response := pending(r)
	response.State = "unknown"
	return checkedResponse(r, response)
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
	return h.serve(ctx, r, raw)
}

// serve is everything after the installation and managed-host checks.
func (h *Handler) serve(ctx context.Context, r benchcoordinatorwire.Request, raw []byte) (benchcoordinatorwire.Response, error) {
	p, err := h.profile(r)
	if err != nil {
		if r.Operation == "status" {
			return h.superseded(ctx, r)
		}
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
		if _, terminal := benchlaunch.RefusalCode(err); terminal {
			return failed(r, err)
		}
		if err != nil {
			return pending(r), err
		}
		send, err := intents.ClaimEffects(ctx, raw)
		if err != nil {
			return pending(r), err
		}
		m := h.manager(r, p, intent, "prepare")
		// The registered launch journals each step before it leaves and never
		// resends one (a sent step is recovered by receipt lookup only), so the
		// identical prepare may resume it: an attempt whose own current check
		// failed after its reservation, before any SuperBench call, finishes
		// here instead of waiting forever. The grouped launch only reads status.
		if prepareResumes(send, p) {
			source, err := m.Prepare(ctx, *intent.Spec, *intent.Task)
			if err != nil {
				return failed(r, err)
			}
			return preparedResponse(r, source)
		}
		return h.status(ctx, r, p, intent)
	}
	intent, err := intents.Read(ctx, r)
	if err != nil {
		return pending(r), ErrIntent
	}
	if r.Operation == "status" {
		return h.status(ctx, r, p, intent)
	}
	if r.Operation == "attach" || r.Operation == "finish" {
		return h.remote(ctx, r, raw, p, intent)
	}
	if p.Launch == benchremote.Mode {
		// A remote launch runs nothing on the bench host; nothing is claimed.
		response := refused(r.Operation)
		response.Code = "unsupported"
		return response, nil
	}
	if intent.Spec == nil {
		return pending(r), ErrIntent
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
	// A registered attempt the hub has definitely superseded may still reach
	// Status, which retires its own record (release, no run); see benchlaunch.
	if intent.Spec == nil {
		// Reserved and never resolved: the in-prepare current check or the
		// read-only choice failed, so no source effect was ever invoked. The
		// hub re-sends the identical retained prepare to finish it.
		if intent.Phase == "reserved" {
			return unresolved(r)
		}
		return refused(r.Operation), ErrCurrent
	}
	if err := h.check(ctx, r, p, intent, "observe"); err != nil && (!errors.Is(err, ErrStale) || !journaled(p)) {
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
	return statusResponse(r, saved, status)
}

// statusResponse is the only place a coordinator Status reaches the wire.
// completed and prepared carry their evidence; every other node-internal state
// (pending, cancel_requested, release_refused, ...) is the wire's parked
// "pending", so a new internal state can never widen the contract.
func statusResponse(r benchcoordinatorwire.Request, saved benchdispatch.SourceSpec, status benchcoordinator.Status) (benchcoordinatorwire.Response, error) {
	if status.State == "completed" && status.Completion != nil && r.Operation != "prepare" {
		return completedResponse(r, saved, *status.Completion)
	}
	if status.State == "prepared" && status.Source != nil && r.Operation != "execute" {
		return preparedResponse(r, *status.Source)
	}
	response := pending(r)
	response.Detail = detail(status.Message, status.LeaseHeld)
	return response, nil
}

// superseded answers status for an attempt whose target this node no longer
// serves: a node build or pin change replaced the profile that prepared it, so
// no prepare or execute can ever reach it again. The node retires its own
// record and answers stale_owner, which the hub reads as the node's proof that
// nothing is outstanding, but only when both keys agree and nothing launched:
//
//   - the hub's authenticated current decision for the attempt's own retained
//     identity, target and profile is stale_owner (a hub that cannot be reached
//     or answers anything else retires nothing), and
//   - the record provably launched nothing: the intent never handed off its
//     effects (reserved or resolved: no source call was ever made), or its
//     registered journal record never sent the run. Retiring it releases the
//     lease the record holds, with that record's token, and never runs.
//
// Everything else (no intent, a grouped launch, a sent run) stays refused
// unavailable, parked for an owner or admin.
func (h *Handler) superseded(ctx context.Context, r benchcoordinatorwire.Request) (benchcoordinatorwire.Response, error) {
	if r.Identity == nil || r.Target == nil {
		return refused(r.Operation), ErrRegistry
	}
	intent, err := IntentStore{Root: h.registry.IntentRoot}.Read(ctx, r)
	if err != nil {
		return refused(r.Operation), ErrRegistry
	}
	stored, err := benchcoordinatorwire.ParseRequest([]byte(intent.PrepareRequest))
	if err != nil || stored.Task == nil {
		return refused(r.Operation), ErrIntent
	}
	if err := h.check(ctx, r, LocalProfile{ID: stored.Task.ProfileID}, intent, "observe"); !errors.Is(err, ErrStale) {
		return refused(r.Operation), ErrCurrent
	}
	if intent.Phase == "reserved" || intent.Phase == "resolved" {
		return staleOwner(r), nil
	}
	if intent.Spec == nil {
		return refused(r.Operation), ErrIntent
	}
	// Only the registered launch can retire on its own; its journal is the
	// registry's, not the replaced profile's.
	m := benchlaunch.Coordinator{Journal: benchlaunch.Journal{Root: filepath.Join(h.registry.StateRoot, "registered")}, Producer: h.client,
		Current: func(context.Context, benchdispatch.SourceSpec) error { return benchlaunch.ErrSuperseded }}
	status, err := m.RetireUnlaunched(ctx, *intent.Spec)
	if err != nil {
		if code, ok := benchlaunch.RefusalCode(err); ok && code == "stale_owner" {
			return staleOwner(r), nil
		}
		return refused(r.Operation), err
	}
	// The veto is journaled and its release still outstanding: parked, retried.
	return statusResponse(r, *intent.Spec, status)
}

func staleOwner(r benchcoordinatorwire.Request) benchcoordinatorwire.Response {
	response := refused(r.Operation)
	response.Code = "stale_owner"
	return response
}

// choiceRefusal is a prepare whose repository choice the node cannot serve: a
// name the profile does not hold, or a bench that already exists with another
// set. It is the launch's terminal refusal, so the hub ends the attempt with
// the reason instead of parking it, and the same prepare is refused again.
func choiceRefusal(message string) error {
	return &benchlaunch.Refusal{Code: "unsupported", Message: message}
}

// selected is the profile narrowed to a prepare's repository choice. The
// registry holds the stage's allow-list with clone URLs; a stage whose cards
// choose sends the card's names (sorted, unique, holding the start
// repository), and only those are prepared, the start repository being the
// task's. With no names the profile is unchanged.
func selected(p LocalProfile, task *benchcoordinatorwire.Task) (LocalProfile, error) {
	if task == nil || len(task.RepositoryNames) == 0 {
		return p, nil
	}
	byName := make(map[string]LocalRepository, len(p.Repositories))
	for _, repo := range p.Repositories {
		byName[repo.Name] = repo
	}
	out := p
	out.Repositories = make([]LocalRepository, 0, len(task.RepositoryNames))
	start := false
	for i, name := range task.RepositoryNames {
		repo, ok := byName[name]
		if !ok || i > 0 && task.RepositoryNames[i-1] >= name {
			return LocalProfile{}, choiceRefusal("the card chose a repository this stage's registry does not serve: " + name)
		}
		out.Repositories = append(out.Repositories, repo)
		start = start || name == task.RepositoryName
	}
	if !start {
		return LocalProfile{}, choiceRefusal("the card's start repository is not one it chose")
	}
	out.CheckpointRepository = task.RepositoryName
	return out, nil
}

// sameBench refuses a card's existing bench whose repositories or start
// repository differ from this prepare's: the choice is frozen once the bench
// exists. Reclaim the bench, then a new claim starts a new one.
func sameBench(entry *benchworkspace.WorkspaceInventory, p LocalProfile) error {
	same := len(entry.Members) == len(p.Repositories) && entry.CheckpointRepository == p.CheckpointRepository
	for i := 0; same && i < len(entry.Members); i++ {
		same = entry.Members[i].Name == p.Repositories[i].Name
	}
	if same {
		return nil
	}
	have := make([]string, 0, len(entry.Members))
	for _, m := range entry.Members {
		have = append(have, m.Name)
	}
	return choiceRefusal("this card's bench already holds " + strings.Join(have, ", ") + " starting in " + entry.CheckpointRepository +
		"; a card's repositories are fixed once its bench exists: reclaim the bench to change them")
}

// attemptRepositories is the registry profile's repositories the attempt's
// spec names, in its order: all of them for a fixed stage, the card's choice
// otherwise. With no spec yet, the whole profile.
func attemptRepositories(p LocalProfile, spec *benchdispatch.SourceSpec) []LocalRepository {
	if spec == nil {
		return p.Repositories
	}
	byName := make(map[string]LocalRepository, len(p.Repositories))
	for _, repo := range p.Repositories {
		byName[repo.Name] = repo
	}
	out := make([]LocalRepository, 0, len(spec.Repositories))
	for _, want := range spec.Repositories {
		if repo, ok := byName[want.Name]; ok {
			out = append(out, repo)
		}
	}
	return out
}
