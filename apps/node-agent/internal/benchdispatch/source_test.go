package benchdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

type sourceTrial struct {
	coordinator SourceCoordinator
	spec        SourceSpec
	task        SourceTask
	mu          sync.Mutex
	calls       map[string]int
	intercept   func(http.ResponseWriter, *http.Request, benchworkspace.Request) bool
}

func (t *sourceTrial) count(step string) int { t.mu.Lock(); defer t.mu.Unlock(); return t.calls[step] }
func sourceFixture(t *testing.T, create bool) *sourceTrial {
	t.Helper()
	s, p, _ := groupedFixture(t)
	root := p.Grouped.WorkspaceRoot
	if e := os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	trial := &sourceTrial{calls: map[string]int{}, task: SourceTask{Arguments: []string{"/bin/sh", "-c", "exit 0"}, Prompt: "private task", Environment: map[string]string{}, TimeoutSeconds: 30, RepositoryName: "b"}}
	trial.spec = SourceSpec{Identity: p.Identity, HostID: p.HostID, BenchKey: p.BenchKey, Holder: p.Holder, DataRoot: filepath.Dir(filepath.Dir(root)), ContextParent: filepath.Dir(p.ContextPath), CheckpointRepository: "a", WorkerPath: p.ExecutablePath, WorkerSHA256: p.ExecutableSHA256, Create: create, LeaseRequestID: "source-lease", RunRequestID: "source-run"}
	if create {
		trial.spec.CreateRequestID = "source-create"
	}
	trial.spec.TaskSHA256 = SourceTaskSHA256(trial.task)
	var repos []benchworkspace.Repository
	for _, m := range p.Grouped.Members {
		url := "/authorized/" + m.Name
		trial.spec.Repositories = append(trial.spec.Repositories, SourceRepository{Name: m.Name, RepositorySHA256: digest([]byte(url)), TaskRef: m.TaskRef, Base: "main", ObjectFormat: m.ObjectFormat})
		repos = append(repos, benchworkspace.Repository{Name: m.Name, Repository: url, Branch: strings.TrimPrefix(m.TaskRef, "refs/heads/"), Base: "main"})
	}
	socketDir, e := os.MkdirTemp("/tmp", "source-coordinator-")
	if e != nil {
		t.Fatal(e)
	}
	socket := filepath.Join(socketDir, "api.sock")
	listener, e := (&net.ListenConfig{}).Listen(t.Context(), "unix", socket)
	if e != nil {
		_ = os.RemoveAll(socketDir)
		t.Fatal(e)
	}
	server := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, e := io.ReadAll(io.LimitReader(r.Body, benchworkspace.MaxBody+1))
		if e != nil {
			t.Error(e)
			return
		}
		request, e := benchworkspace.Parse(raw)
		if e != nil {
			t.Error("invalid actual request", e)
			return
		}
		trial.mu.Lock()
		trial.calls[request.Operation]++
		trial.mu.Unlock()
		if trial.intercept != nil && trial.intercept(w, r, request) {
			return
		}
		workspace := benchworkspace.Workspace{Key: trial.spec.BenchKey, BenchID: strings.Repeat("b", 32), Phase: "ready", MemberCount: 2, CheckpointRepository: "a", ReadyForAcquisition: true, QuotaBytes: 64 << 20, QuotaInodes: 4096, Checkpoint: &benchworkspace.Checkpoint{GenerationID: strings.Repeat("c", 32), ManifestSHA256: strings.Repeat("d", 64), Seal: strings.Repeat("e", 40), Members: []benchworkspace.Commit{{Name: "a", Commit: strings.Repeat("a", 40)}, {Name: "b", Commit: strings.Repeat("b", 64)}}}}
		mutation := &benchworkspace.Mutation{Workspace: workspace}
		switch request.Operation {
		case "create":
			mutation.RootPath = root
		case "lease", "checkpoint":
			mutation.Workspace.ReadyForAcquisition = false
			mutation.Workspace.Lease = &benchworkspace.LeaseSummary{Holder: trial.spec.Holder, Mode: "cooperative"}
			if request.Operation == "lease" {
				mutation.Grant = &benchworkspace.Grant{LeaseToken: strings.Repeat("d", 48)}
				mutation.RootPath = root
			}
		default:
			t.Error("unexpected network effect", request.Operation)
		}
		response := benchworkspace.Response{Version: benchworkspace.Version, Operation: request.Operation, RequestID: request.RequestID, OK: true, Result: mutation}
		body, e := json.Marshal(response)
		if e != nil {
			t.Error(e)
			return
		}
		if _, e = benchworkspace.ParseResponse(body, 200, request); e != nil {
			t.Error("invalid fixture response", request.Operation, e)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})}
	done := make(chan struct{})
	go func() { defer close(done); _ = server.Serve(listener) }()
	client, e := benchworkspace.NewClient(socket, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { client.Close(); _ = server.Close(); <-done; _ = os.RemoveAll(socketDir) })
	trial.coordinator = SourceCoordinator{Store: s, Client: client, Repositories: repos, ContextParent: filepath.Dir(p.ContextPath), Current: func(context.Context, SourceSpec) error { return nil }}
	return trial
}

func TestSourceCoordinatorRealUnixCreateLeaseCheckpointBindsNoPayload(t *testing.T) {
	for _, create := range []bool{false, true} {
		t.Run(strconv.FormatBool(create), func(t *testing.T) {
			trial := sourceFixture(t, create)
			p, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task)
			if e != nil {
				t.Fatal(e)
			}
			if p.Grouped == nil || p.RegistrationID != strings.Repeat("b", 32) || len(p.Sources) != 2 || p.Grouped.Members[1].ObjectFormat != "sha256" || p.Sources[1].Commit != strings.Repeat("b", 64) {
				t.Fatal("bound caller data instead of observed complete source")
			}
			if trial.count("lease") != 1 || trial.count("checkpoint") != 1 || trial.count("run") != 0 || create && trial.count("create") != 1 {
				t.Fatal("wrong concrete operations", trial.calls)
			}
			record, e := trial.coordinator.Store.Inspect(t.Context(), p)
			if e != nil || record.Phase != "prepared" || record.Source == nil {
				t.Fatal("not bound atomically", e)
			}
			if _, e = os.Stat(filepath.Join(p.ContextPath, "started")); !os.IsNotExist(e) {
				t.Fatal("preparation launched worker")
			}
			saved, e := trial.coordinator.Store.BoundSource(t.Context(), trial.spec)
			if e != nil || !samePlan(saved, p) {
				t.Fatal("lost reply did not return exact cap-free binding", e)
			}
			if _, e = trial.coordinator.Prepare(t.Context(), trial.spec, trial.task); e == nil || trial.count("lease") != 1 {
				t.Fatal("binding retry performed growth", e)
			}
			raw, e := os.ReadFile(filepath.Join(trial.coordinator.Store.Root, digest([]byte(p.BenchKey))+".json"))
			if e != nil {
				t.Fatal(e)
			}
			for _, private := range []string{strings.Repeat("d", 48), "/authorized/", trial.task.Prompt, "/bin/sh"} {
				if strings.Contains(string(raw), private) {
					t.Fatal("ordinary journal contains private payload/URL/capability")
				}
			}
		})
	}
}

func TestSourceUncertainAndBeforeSendIntentNeverRedispatchOrAdopt(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(strconv.FormatBool(lost), func(t *testing.T) {
			trial := sourceFixture(t, false)
			request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "lease", Key: trial.spec.BenchKey, Holder: trial.spec.Holder, RequestID: trial.spec.LeaseRequestID}
			if lost {
				trial.intercept = func(w http.ResponseWriter, _ *http.Request, r benchworkspace.Request) bool {
					connection, _, e := w.(http.Hijacker).Hijack()
					if e != nil {
						t.Error(e)
						return true
					}
					_ = connection.Close()
					return true
				}
				if _, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task); !errors.Is(e, ErrPending) {
					t.Fatal(e)
				}
			} else {
				if e := trial.coordinator.Store.ReserveSource(t.Context(), trial.spec, trial.coordinator.Current); e != nil {
					t.Fatal(e)
				}
				send, e := trial.coordinator.Store.BeginSourceOperation(t.Context(), trial.spec, "lease", request, trial.coordinator.Current)
				if e != nil || !send {
					t.Fatal(e)
				}
			}
			before := trial.count("lease")
			if _, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task); !errors.Is(e, ErrPending) || trial.count("lease") != before || trial.count("checkpoint") != 0 {
				t.Fatal("unknown operation resent", e)
			}
			other := trial.spec
			other.Identity.Epoch++
			other.Identity.AttemptID = "attempt-other"
			if e := trial.coordinator.Store.ReserveSource(t.Context(), other, trial.coordinator.Current); !errors.Is(e, ErrPending) {
				t.Fatal("reclaimed epoch adopted unknown effects", e)
			}
			_, scalar, _ := fixture(t)
			scalar.BenchKey = trial.spec.BenchKey
			if e := trial.coordinator.Store.Prepare(t.Context(), scalar); !errors.Is(e, ErrPending) {
				t.Fatal("scalar bypassed pending source exclusion", e)
			}
		})
	}
}

func TestSourceCapturedReplyRecoveryWithoutSecondLease(t *testing.T) {
	trial := sourceFixture(t, false)
	s := trial.coordinator.Store
	if e := s.ReserveSource(t.Context(), trial.spec, trial.coordinator.Current); e != nil {
		t.Fatal(e)
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "lease", Key: trial.spec.BenchKey, Holder: trial.spec.Holder, RequestID: trial.spec.LeaseRequestID}
	if send, e := s.BeginSourceOperation(t.Context(), trial.spec, "lease", request, trial.coordinator.Current); e != nil || !send {
		t.Fatal(e)
	}
	_, capture, e := trial.coordinator.Client.DoWithEvidence(t.Context(), request)
	if e != nil {
		t.Fatal(e)
	}
	// Simulate crash after private receipt fsync but before document advancement.
	if e = capture.Use(func(status int, _, body []byte) error {
		return s.writeSourceFile(sourceFile(trial.spec, "lease", ".response"), append([]byte(strconv.Itoa(status)+"\n"), body...))
	}); e != nil {
		t.Fatal(e)
	}
	if _, e = trial.coordinator.Prepare(t.Context(), trial.spec, trial.task); e != nil || trial.count("lease") != 1 || trial.count("checkpoint") != 1 {
		t.Fatal("did not resume captured evidence", e)
	}
}

func TestSourcePreflightAndCurrentAuthorityRefuseBeforeGrowth(t *testing.T) {
	for _, change := range []string{"task", "repository", "context-inside-data", "authority"} {
		t.Run(change, func(t *testing.T) {
			trial := sourceFixture(t, false)
			switch change {
			case "task":
				trial.task.Prompt = "different task"
			case "repository":
				trial.coordinator.Repositories[1].Repository = "/unapproved/repo"
			case "context-inside-data":
				path := filepath.Join(trial.spec.DataRoot, "contexts")
				if e := os.Mkdir(path, 0700); e != nil {
					t.Fatal(e)
				}
				trial.spec.ContextParent = path
				trial.coordinator.ContextParent = path
			case "authority":
				trial.coordinator.Current = func(context.Context, SourceSpec) error { return ErrOwner }
			}
			if _, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task); e == nil || trial.count("lease") != 0 {
				t.Fatal("invalid source authority caused growth", e)
			}
		})
	}
}

func TestSourceConcurrentReservationAndRequestConsumeExactlyOnce(t *testing.T) {
	trial := sourceFixture(t, false)
	s := trial.coordinator.Store
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Go(func() { results <- s.ReserveSource(t.Context(), trial.spec, trial.coordinator.Current) })
	}
	wg.Wait()
	close(results)
	for e := range results {
		if e != nil {
			t.Fatal(e)
		}
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "lease", Key: trial.spec.BenchKey, Holder: trial.spec.Holder, RequestID: trial.spec.LeaseRequestID}
	sends := make(chan bool, 2)
	for i := 0; i < 2; i++ {
		wg.Go(func() {
			send, e := s.BeginSourceOperation(t.Context(), trial.spec, "lease", request, trial.coordinator.Current)
			if e != nil {
				t.Error(e)
			}
			sends <- send
		})
	}
	wg.Wait()
	close(sends)
	count := 0
	for send := range sends {
		if send {
			count++
		}
	}
	if count != 1 {
		t.Fatal("more than one source send admitted", count)
	}
	if trial.count("lease") != 0 {
		t.Fatal("journal method performed network effect")
	}
}

func TestSourceCurrentPolicyRecheckedAfterActualReply(t *testing.T) {
	trial := sourceFixture(t, false)
	var revoked atomic.Bool
	// Request handling and the resumed caller synchronize through the HTTP reply.
	trial.intercept = func(_ http.ResponseWriter, _ *http.Request, r benchworkspace.Request) bool {
		if r.Operation == "checkpoint" {
			revoked.Store(true)
		}
		return false
	}
	trial.coordinator.Current = func(context.Context, SourceSpec) error {
		if revoked.Load() {
			return ErrOwner
		}
		return nil
	}
	if _, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task); !errors.Is(e, ErrOwner) {
		t.Fatal("post-await revocation ignored", e)
	}
	if _, e := trial.coordinator.Store.BoundSource(t.Context(), trial.spec); !errors.Is(e, ErrPending) {
		t.Fatal("revoked source became runnable", e)
	}
	if _, e := trial.coordinator.Store.SourceReply(t.Context(), trial.spec, "checkpoint"); e != nil {
		t.Fatal("actual reply lost on revocation", e)
	}
}

func TestSourceReplyTamperingAndFutureFieldsInLegacyVersionRefuse(t *testing.T) {
	trial := sourceFixture(t, false)
	s := trial.coordinator.Store
	if _, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task); e != nil {
		t.Fatal(e)
	}
	// The bound record is immutable and replays remain cap-free even if a private
	// receipt is corrupted later; it cannot become a new source reservation.
	next := trial.spec
	next.Identity.RunID = "run_next001"
	next.Identity.AttemptID = "next-attempt"
	next.Identity.Epoch++
	if e := s.ReserveSource(t.Context(), next, trial.coordinator.Current); !errors.Is(e, ErrConflict) {
		t.Fatal("historical source request IDs reused", e)
	}
	path := filepath.Join(s.Root, digest([]byte(trial.spec.BenchKey))+".json")
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var doc state
	if e = json.Unmarshal(raw, &doc); e != nil {
		t.Fatal(e)
	}
	doc.Version = version
	corrupt, e := json.Marshal(doc)
	if e != nil {
		t.Fatal(e)
	}
	root, e := os.OpenRoot(s.Root)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	if e = root.WriteFile(filepath.Base(path), corrupt, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = s.BoundSource(t.Context(), trial.spec); !errors.Is(e, ErrInvalid) {
		t.Fatal("legacy version accepted future source authority", e)
	}
	after, e := root.ReadFile(filepath.Base(path))
	if e != nil || string(after) != string(corrupt) {
		t.Fatal("invalid state rewritten", e)
	}
}

func TestSourceCapturedCheckpointBytesCannotBeRebound(t *testing.T) {
	trial := sourceFixture(t, false)
	var revoked atomic.Bool
	trial.intercept = func(_ http.ResponseWriter, _ *http.Request, r benchworkspace.Request) bool {
		if r.Operation == "checkpoint" {
			revoked.Store(true)
		}
		return false
	}
	trial.coordinator.Current = func(context.Context, SourceSpec) error {
		if revoked.Load() {
			return ErrOwner
		}
		return nil
	}
	if _, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task); !errors.Is(e, ErrOwner) {
		t.Fatal(e)
	}
	root, e := os.OpenRoot(trial.coordinator.Store.Root)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	name := sourceFile(trial.spec, "checkpoint", ".response")
	raw, e := root.ReadFile(name)
	if e != nil {
		t.Fatal(e)
	}
	// Keep a structurally valid response while changing its actual vector.
	var body map[string]any
	if e = json.Unmarshal(raw[4:], &body); e != nil {
		t.Fatal(e)
	}
	checkpoint := body["result"].(map[string]any)["workspace"].(map[string]any)["checkpoint"].(map[string]any)
	checkpoint["members"].([]any)[0].(map[string]any)["commit"] = strings.Repeat("f", 40)
	changed, e := json.Marshal(body)
	if e != nil {
		t.Fatal(e)
	}
	if e = root.WriteFile(name, append(raw[:4:4], changed...), 0600); e != nil {
		t.Fatal(e)
	}
	revoked.Store(false)
	if _, e = trial.coordinator.Prepare(t.Context(), trial.spec, trial.task); e == nil || trial.count("lease") != 1 || trial.count("checkpoint") != 1 {
		t.Fatal("changed private vector rebound or resent", e)
	}
	if _, e = trial.coordinator.Store.BoundSource(t.Context(), trial.spec); !errors.Is(e, ErrPending) {
		t.Fatal("tampered source became runnable", e)
	}
}

func TestSourceBindingCannotReplaceFrozenTask(t *testing.T) {
	trial := sourceFixture(t, false)
	s := trial.coordinator.Store
	p, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task)
	if e != nil {
		t.Fatal(e)
	}
	// Restore the exact pre-bind journal state using the captured real exchanges,
	// then attempt to bind a different task under the original source reservation.
	if e = s.withState(t.Context(), p, false, func(doc *state) (bool, error) {
		doc.Source = doc.Records[0].Source
		doc.Records = nil
		return true, nil
	}); e != nil {
		t.Fatal(e)
	}
	root, e := os.OpenRoot(p.ContextPath)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	raw, e := root.ReadFile("request.json")
	if e != nil {
		t.Fatal(e)
	}
	var worker superbench.GroupedWorkerSpec
	if e = json.Unmarshal(raw, &worker); e != nil {
		t.Fatal(e)
	}
	worker.Prompt = "unapproved replacement task"
	raw, e = json.Marshal(worker)
	if e != nil {
		t.Fatal(e)
	}
	if e = root.WriteFile("request.json", raw, 0600); e != nil {
		t.Fatal(e)
	}
	p.ContextSHA256 = digest(raw)
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "run", Key: p.BenchKey, Holder: p.Holder, RequestID: p.RequestID, LeaseToken: strings.Repeat("d", 48), Arguments: []string{p.ExecutablePath, p.ContextPath, p.ContextSHA256}}
	raw, e = json.Marshal(request)
	if e != nil {
		t.Fatal(e)
	}
	p.RequestSHA256 = digest(raw)
	p.BodySHA256, e = request.Digest()
	if e != nil {
		t.Fatal(e)
	}
	if e = s.BindSource(t.Context(), trial.spec, p, raw, trial.coordinator.Current); !errors.Is(e, ErrInvalid) {
		t.Fatal("frozen source task replaced", e)
	}
	if trial.count("lease") != 1 || trial.count("checkpoint") != 1 || trial.count("run") != 0 {
		t.Fatal("replacement caused network effect")
	}
}

func TestSourceDispatchRequiresPreservedExactReceipts(t *testing.T) {
	trial := sourceFixture(t, false)
	s := trial.coordinator.Store
	p, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task)
	if e != nil {
		t.Fatal(e)
	}
	root, e := os.OpenRoot(s.Root)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	if e = root.Remove(sourceFile(trial.spec, "checkpoint", ".response")); e != nil {
		t.Fatal(e)
	}
	if _, e = s.BoundSource(t.Context(), trial.spec); e == nil {
		t.Fatal("missing receipt granted bound replay")
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "run", Key: p.BenchKey, Holder: p.Holder, RequestID: p.RequestID, LeaseToken: strings.Repeat("d", 48), Arguments: []string{p.ExecutablePath, p.ContextPath, p.ContextSHA256}}
	raw, e := json.Marshal(request)
	if e != nil {
		t.Fatal(e)
	}
	called := false
	if e = s.Dispatch(t.Context(), p, raw, allow, func(context.Context) error { called = true; return nil }); e == nil || called {
		t.Fatal("missing actual receipt dispatched", e)
	}
}

func TestSourceMigrationPreservesHistoricalScalarProposal(t *testing.T) {
	s, old, raw := fixture(t)
	prepare(t, s, old)
	dispatch(t, s, old, raw)
	proof, e := s.StageProposal(t.Context(), old, observation(old), allow, verified)
	if e != nil {
		t.Fatal(e)
	}
	trial := sourceFixture(t, false)
	trial.spec.BenchKey = old.BenchKey
	if e = s.ReserveSource(t.Context(), trial.spec, trial.coordinator.Current); e != nil {
		t.Fatal(e)
	}
	record, e := s.Inspect(t.Context(), old)
	if e != nil || record.Phase != "proposed" || string(record.Proposal) != string(proof) {
		t.Fatal("legacy proposal meaning or bytes changed", e)
	}
	called := false
	if e = s.Dispatch(t.Context(), old, raw, allow, func(context.Context) error { called = true; return nil }); !errors.Is(e, ErrOwner) || called {
		t.Fatal("historical scalar bypassed new source reservation", e)
	}
}
