package benchlaunch

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

func testSpec() (benchdispatch.SourceSpec, benchdispatch.SourceTask, []benchworkspace.Repository) {
	id := benchattempt.Identity{TenantID: "tenant", BoardID: "brd_board1", CardID: "card_card01", StageID: "write", RunID: "run_run001", Epoch: 1, AgentID: "executor", StationID: "station", NodeID: "node", AttemptID: "attempt-1", ControlPrincipalID: "principal", ControlGrantID: "control-grant", PolicySHA256: digest([]byte("policy"))}
	task := benchdispatch.SourceTask{Arguments: []string{"/usr/local/bin/harness"}, Prompt: "do the card", Environment: map[string]string{}, TimeoutSeconds: 60, RepositoryName: "a"}
	spec := benchdispatch.SourceSpec{Identity: id, HostID: "host", BenchKey: "cp_test", Holder: "cp_holder", ContextParent: "/private-context", DataRoot: "/data", CheckpointRepository: "a", WorkerPath: "/opt/agentpod-bench-worker", WorkerSHA256: digest([]byte("worker")), TaskSHA256: benchdispatch.SourceTaskSHA256(task), LeaseRequestID: "lease_x", RunRequestID: "run_x"}
	var repos []benchworkspace.Repository
	for _, name := range []string{"a", "b"} {
		url := "/authorized/" + name
		spec.Repositories = append(spec.Repositories, benchdispatch.SourceRepository{Name: name, RepositorySHA256: digest([]byte(url)), TaskRef: "refs/heads/card/" + id.CardID, Base: "main", ObjectFormat: "sha1"})
		repos = append(repos, benchworkspace.Repository{Name: name, Repository: url, Branch: "card/" + id.CardID, Base: "main"})
	}
	return spec, task, repos
}

type trial struct {
	*fakeBench
	c          Coordinator
	spec       benchdispatch.SourceSpec
	task       benchdispatch.SourceTask
	stale      atomic.Bool
	superseded atomic.Bool
	// current is the one spec the hub treats as current; every other spec is
	// treated as definitely superseded (ErrSuperseded). The real handler only
	// says so on an authenticated stale_owner decision and otherwise returns
	// ErrCurrent, which retires nothing.
	current atomic.Pointer[benchdispatch.SourceSpec]
	dir     string
}

func newTrial(t *testing.T) *trial {
	spec, task, repos := testSpec()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "journal")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	tr := &trial{fakeBench: newFake(t), spec: spec, task: task, dir: dir}
	tr.c = tr.coordinator(repos)
	tr.current.Store(&spec)
	return tr
}

// coordinator builds a fresh instance over the same journal: a Node restart.
func (tr *trial) coordinator(repos []benchworkspace.Repository) Coordinator {
	return Coordinator{Journal: Journal{Root: tr.dir}, Producer: tr.fakeBench, Repositories: repos, Current: func(_ context.Context, spec benchdispatch.SourceSpec) error {
		if want := tr.current.Load(); want != nil && !reflect.DeepEqual(*want, spec) {
			return ErrSuperseded
		}
		if tr.superseded.Load() {
			return ErrSuperseded
		}
		if tr.stale.Load() {
			return errors.New("hub unavailable")
		}
		return nil
	}}
}

func admitAll(context.Context, benchdispatch.SourceBinding) error { return nil }

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if got, ok := RefusalCode(err); !ok || got != code {
		t.Fatalf("want refusal %s, got %v", code, err)
	}
}

func (tr *trial) prepare(t *testing.T) benchcoordinator.Prepared {
	t.Helper()
	p, err := tr.c.Prepare(context.Background(), tr.spec, tr.task)
	if err != nil {
		t.Fatal("prepare", err)
	}
	return p
}

func TestRegisteredLaunchEndToEnd(t *testing.T) {
	tr := newTrial(t)
	p := tr.prepare(t)
	b := p.Binding
	if len(b.Operations) != 2 || b.Operations[0].Step != "lease" || b.Operations[1].Step != "checkpoint" || b.ContextSHA256 == "" || p.SourceRequestSHA256 == "" || b.Members[0].Commit != fakeCommitA {
		t.Fatal("binding incomplete", b.Operations)
	}
	if tr.count(tr.posts, "run") != 0 || tr.count(tr.posts, "observe") != 1 {
		t.Fatal("prepare launched or skipped the observation")
	}
	completion, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	if err != nil {
		t.Fatal(err)
	}
	if completion.Task.Outcome != "complete" || completion.Task.Handoff["summary"] != "done" || !completion.Service.Released || completion.Service.Kind != "grouped-v2" || completion.Service.Checkpoints[0].Commit != strings.Repeat("e", 40) || completion.SourceReceiptSHA256 == "" {
		t.Fatal("completion incomplete", completion.Service)
	}
	// Only the capsule digest and the mode travel as arguments: no path to a
	// Node-private file reaches the payload.
	if tr.runArgs[0] != tr.spec.WorkerPath || tr.runArgs[1] != Mode || tr.runArgs[2] != b.ContextSHA256 || tr.lastCapsule.Task.Prompt != "do the card" || tr.lastCapsule.Task.WorkspaceRoot != "/data/benches/cp_test" {
		t.Fatal("capsule not delivered on stdin", tr.runArgs)
	}
	if tr.count(tr.posts, "lookup") != 1 {
		t.Fatal("receipt was not read back")
	}
	again, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	status, serr := tr.c.Status(context.Background(), tr.spec)
	if err != nil || serr != nil || again.Service.ResponseSHA256 != completion.Service.ResponseSHA256 || status.State != "completed" || tr.count(tr.posts, "run") != 1 {
		t.Fatal("replay was not exact or launched again", err, serr, status.State)
	}
	// The completion must satisfy the coordinator wire, unchanged.
	if benchdispatch.SourceBindingSHA256(completion.Source) != p.BindingSHA256 {
		t.Fatal("completion binding drifted")
	}
}

func TestLostRunReplyIsRecoveredByReceiptNeverResent(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.loseAfter["run"] = true
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("lost reply was not pending", err)
	}
	restarted := tr.coordinator(tr.c.Repositories)
	if _, err := restarted.Execute(context.Background(), tr.spec, admitAll); err != nil {
		t.Fatal("receipt recovery failed", err)
	}
	if tr.count(tr.posts, "run") != 1 || tr.count(tr.effects, "run") != 1 {
		t.Fatal("run was sent again", tr.count(tr.posts, "run"))
	}
}

func TestLostLeaseReplyIsRecoveredByReceipt(t *testing.T) {
	tr := newTrial(t)
	tr.loseAfter["lease"] = true
	if _, err := tr.c.Prepare(context.Background(), tr.spec, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("lost lease reply was not pending", err)
	}
	tr.prepare(t)
	if tr.count(tr.posts, "lease") != 1 || tr.count(tr.effects, "lease") != 1 {
		t.Fatal("lease was sent again")
	}
}

func TestAbsentReceiptParksWithoutResend(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.loseBefore["run"] = true
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := tr.c.Status(context.Background(), tr.spec); !errors.Is(err, benchdispatch.ErrPending) {
			t.Fatal("absent receipt did not park", err)
		}
		if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
			t.Fatal("absent receipt did not park", err)
		}
	}
	if tr.count(tr.posts, "run") != 1 {
		t.Fatal("an absent receipt licensed a resend")
	}
}

func TestInProgressIsNotFinal(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.inProgress["run"] = true
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("in_progress was treated as final", err)
	}
	status, err := tr.c.Status(context.Background(), tr.spec)
	if err != nil || status.State != "completed" || tr.count(tr.posts, "run") != 1 {
		t.Fatal("in-progress run was not recovered from its receipt", err)
	}
}

func TestCapacityRefusalIsSurfacedAndNotRetried(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.capacity["run"] = true
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "capacity_exhausted")
	if tr.count(tr.effects, "release") != 1 || tr.leased {
		t.Fatal("held lease was not released after the refusal")
	}
	delete(tr.capacity, "run")
	_, err = tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "capacity_exhausted")
	_, err = tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "capacity_exhausted")
	if tr.count(tr.posts, "run") != 1 {
		t.Fatal("capacity refusal was retried")
	}
}

func TestCapacityOnLeaseHoldsNothing(t *testing.T) {
	tr := newTrial(t)
	tr.capacity["lease"] = true
	_, err := tr.c.Prepare(context.Background(), tr.spec, tr.task)
	wantCode(t, err, "capacity_exhausted")
	_, err = tr.c.Prepare(context.Background(), tr.spec, tr.task)
	wantCode(t, err, "capacity_exhausted")
	if tr.count(tr.posts, "lease") != 1 || tr.count(tr.posts, "release") != 0 {
		t.Fatal("refused lease was retried or released")
	}
}

func TestStaleHubDecisionSendsNothing(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.stale.Store(true)
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "stale_owner")
	tr.stale.Store(false)
	refusing := func(context.Context, benchdispatch.SourceBinding) error { return errors.New("not admitted") }
	_, err = tr.c.Execute(context.Background(), tr.spec, refusing)
	wantCode(t, err, "stale_owner")
	if tr.count(tr.posts, "run") != 0 {
		t.Fatal("a stale or unadmitted holder launched")
	}
}

// The admission gate is rechecked under the journal lock, right before "sent".
func TestStaleDecisionAtTheLastMomentSendsNothing(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	calls := 0
	c := tr.c
	c.Current = func(context.Context, benchdispatch.SourceSpec) error {
		calls++
		if calls > 2 {
			return errors.New("superseded")
		}
		return nil
	}
	_, err := c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "stale_owner")
	if tr.count(tr.posts, "run") != 0 {
		t.Fatal("run sent after the decision went stale")
	}
}

func TestProducerFencingStopsAStaleToken(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.token = strings.Repeat("7", 32) // another holder now owns the lease
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "stale_owner")
	if tr.count(tr.posts, "release") != 0 {
		t.Fatal("a fenced holder tried to release a lease it no longer owns")
	}
}

func nextAttempt(spec benchdispatch.SourceSpec) benchdispatch.SourceSpec {
	next := spec
	next.Identity.RunID, next.Identity.AttemptID, next.Identity.Epoch, next.Holder = "run_run002", "attempt-2", 2, "cp_other"
	next.LeaseRequestID, next.RunRequestID = "lease_y", "run_y"
	return next
}

// While the older attempt's run may still be executing, nothing can take the
// bench: the newer attempt is refused and never reaches the producer.
func TestNewAttemptWaitsForAnUnresolvedRun(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.loseAfter["run"] = true
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal(err)
	}
	tr.lookup = "in_progress"
	next := nextAttempt(tr.spec)
	tr.current.Store(&next)
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("newer attempt did not wait for the unresolved run", err)
	}
	if tr.count(tr.posts, "lease") != 1 || tr.count(tr.posts, "run") != 1 {
		t.Fatal("a second attempt reached the producer while a run was unresolved")
	}
}

func (tr *trial) record(t *testing.T, spec benchdispatch.SourceSpec) (record, bool) {
	t.Helper()
	r, active, err := tr.c.Journal.read(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	return r, active
}

func (tr *trial) assertRetired(t *testing.T) {
	t.Helper()
	r, active := tr.record(t, tr.spec)
	if !r.terminal() || active || !r.Cancelled || r.Release != "done" {
		t.Fatal("stale record not terminal", r.Phase, r.Release, active)
	}
	if tr.count(tr.effects, "release") != 1 || tr.leased || tr.count(tr.posts, "run") != 0 {
		t.Fatal("stale attempt kept its lease or launched", tr.count(tr.effects, "release"), tr.leased)
	}
	next := nextAttempt(tr.spec)
	tr.superseded.Store(false)
	tr.stale.Store(false)
	tr.current.Store(&next)
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("next attempt on the same card refused", err)
	}
	if _, err := tr.c.Execute(context.Background(), next, admitAll); err != nil {
		t.Fatal("next attempt did not run", err)
	}
}

func TestStaleAfterPrepareStatusRetiresTheRecord(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.superseded.Store(true)
	_, err := tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "stale_owner")
	tr.assertRetired(t)
}

func TestStaleAfterPrepareCancelRetiresTheRecord(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.stale.Store(true) // the hub cannot even be asked; Cancel is gated on the record itself
	_, err := tr.c.Cancel(context.Background(), tr.spec)
	wantCode(t, err, "stale_owner")
	tr.assertRetired(t)
}

func TestNewAttemptSupersedesAPreparedOne(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	next := nextAttempt(tr.spec)
	tr.current.Store(&next)
	if _, err := tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("new current attempt was refused", err)
	}
	old, active := tr.record(t, tr.spec)
	if !old.terminal() || active || tr.count(tr.effects, "release") != 1 || tr.count(tr.effects, "lease") != 2 || tr.count(tr.posts, "run") != 0 {
		t.Fatal("older attempt was not retired cleanly", old.Phase, old.Release)
	}
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !isRefusal(err, "stale_owner") || tr.count(tr.posts, "run") != 0 {
		t.Fatal("retired attempt launched", err)
	}
}

// An unreachable hub is not a stale decision: nothing is released or retired.
func TestUnavailableDecisionRetiresNothing(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.stale.Store(true)
	_, err := tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "stale_owner")
	r, active := tr.record(t, tr.spec)
	if r.Cancelled || !active || r.Phase != phasePrepared || tr.count(tr.posts, "release") != 0 {
		t.Fatal("hub outage retired a live attempt")
	}
}

func TestRefusedReleaseIsRetried(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.refuseRelease = 1
	_, err := tr.c.Cancel(context.Background(), tr.spec)
	if err != nil {
		t.Fatal("a refused release did not stay pending", err)
	}
	_, err = tr.c.Cancel(context.Background(), tr.spec)
	wantCode(t, err, "stale_owner")
	if tr.count(tr.posts, "release") != 2 || tr.count(tr.effects, "release") != 1 || tr.leased {
		t.Fatal("release was not retried", tr.count(tr.posts, "release"))
	}
}

func TestAbsentReadbackIsVerificationFailure(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.lookup = "absent"
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "verification_failed")
}

func TestCancelBeforeLaunchReleasesAndNeverRuns(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	_, err := tr.c.Cancel(context.Background(), tr.spec)
	wantCode(t, err, "stale_owner")
	_, err = tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "stale_owner")
	if tr.count(tr.posts, "run") != 0 || tr.count(tr.effects, "release") != 1 || tr.leased {
		t.Fatal("cancelled attempt launched or kept its lease")
	}
}

func TestCancelMidRunNeverPublishesTheResult(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.loseAfter["run"] = true // the run is in flight from the coordinator's view
	if _, err := tr.c.Execute(context.Background(), tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal(err)
	}
	tr.lookup = "in_progress"
	status, err := tr.c.Cancel(context.Background(), tr.spec)
	if err != nil || status.State != "cancel_requested" || len(tr.cancels) != 1 || tr.cancels[0].TargetRequestID != tr.spec.RunRequestID {
		t.Fatal("mid-run cancel did not target the run", err, status.State, tr.cancels)
	}
	tr.lookup = ""
	_, err = tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "stale_owner")
	_, err = tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "stale_owner")
	if tr.count(tr.posts, "run") != 1 {
		t.Fatal("cancelled run was sent again")
	}
}

func TestContextCancelledWhileRunningLeavesItUncertain(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.block, tr.running = make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { <-tr.running; cancel() }() // the node gives up while the payload runs
	if _, err := tr.c.Execute(ctx, tr.spec, admitAll); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("interrupted run was not left uncertain", err)
	}
	status, err := tr.c.Status(context.Background(), tr.spec)
	if err != nil || status.State != "completed" || tr.count(tr.posts, "run") != 1 {
		t.Fatal("interrupted run was not reconciled from its receipt", err)
	}
}

func isRefusal(err error, code string) bool { got, ok := RefusalCode(err); return ok && got == code }

func TestWorkerCrashIsRefusedAndReleased(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.exit = 1
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "verification_failed")
	if tr.count(tr.effects, "release") != 1 || tr.leased {
		t.Fatal("crashed run kept its lease")
	}
}

func TestInvalidResultIsNeverPublished(t *testing.T) {
	for name, mutate := range map[string]func([]byte) []byte{
		"foreign binding": func(f []byte) []byte {
			return []byte(strings.Replace(string(f), "run_run001", "run_run999", 1))
		},
		"truncated frame": func(f []byte) []byte { return f[:len(f)-1] },
		"trailing byte":   func(f []byte) []byte { return append(f, '\n') },
		"prose":           func([]byte) []byte { return []byte("all done!") },
	} {
		t.Run(name, func(t *testing.T) {
			tr := newTrial(t)
			tr.prepare(t)
			tr.stdout = mutate
			_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
			wantCode(t, err, "verification_failed")
			if _, err = tr.c.Status(context.Background(), tr.spec); !isRefusal(err, "verification_failed") {
				t.Fatal("invalid result later became a completion", err)
			}
		})
	}
}

func TestReadbackMustMatchTheCapturedReply(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.tamperRead = true
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "verification_failed")
}

func TestProducerWithoutTheProfileIsUnsupported(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	orig := tr.c.Producer
	tr.c.Producer = producerFunc(func(ctx context.Context, path, ct string, raw []byte, limit int) (int, []byte, error) {
		if ct == benchworkspace.FiniteContentType && path == benchworkspace.PathOperations {
			return 400, []byte(`{"version":"superbench.v2","ok":false,"error":{"code":"invalid_request","message":"invalid workspace operation request"}}`), nil
		}
		return orig.Post(ctx, path, ct, raw, limit)
	})
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	if !isRefusal(err, "unsupported") {
		t.Fatal("unprofiled producer was not refused", err)
	}
}

type producerFunc func(context.Context, string, string, []byte, int) (int, []byte, error)

func (f producerFunc) Post(ctx context.Context, path, ct string, raw []byte, limit int) (int, []byte, error) {
	return f(ctx, path, ct, raw, limit)
}

func TestJournalIsPrivate(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	st, err := os.Stat(filepath.Join(tr.dir, tr.spec.BenchKey+".json"))
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatal("journal holding the lease token is not private", err)
	}
	if err = os.Chmod(tr.dir, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err = tr.c.Status(context.Background(), tr.spec); err == nil {
		t.Fatal("journal in a shared directory was used")
	}
}

// A refused attempt that still holds its lease (its release failed) must not
// lock the bench once the hub moves on: the newer attempt's prepare retires it.
func TestRefusedRecordStillReleasesAfterTheHubMovesOn(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.capacity["run"], tr.refuseRelease = true, 1
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "capacity_exhausted")
	if r, _ := tr.record(t, tr.spec); r.Release != "needed" || r.Cancelled || !tr.leased || tr.count(tr.posts, "release") != 1 {
		t.Fatal("fixture: the first release should have been refused", r.Release, r.Cancelled)
	}
	delete(tr.capacity, "run")
	next := nextAttempt(tr.spec)
	tr.current.Store(&next) // the old spec is now definitely superseded
	if _, err = tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("the stale refused record locked the bench", err)
	}
	old, active := tr.record(t, tr.spec)
	if !old.terminal() || active || tr.count(tr.effects, "release") != 1 || tr.count(tr.posts, "run") != 1 {
		t.Fatal("refused record was not released and retired", old.Release, active)
	}
	if _, err = tr.c.Execute(context.Background(), next, admitAll); err != nil {
		t.Fatal("next attempt did not run", err)
	}
}

// The same refused record, asked by Status after a stale decision.
func TestRefusedRecordReleasesOnAStaleStatus(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.capacity["run"], tr.refuseRelease = true, 1
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "capacity_exhausted")
	tr.superseded.Store(true)
	_, err = tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "capacity_exhausted")
	if r, active := tr.record(t, tr.spec); !r.terminal() || active || tr.leased || tr.count(tr.effects, "release") != 1 {
		t.Fatal("stale Status left the refused record holding its lease", r.Release)
	}
}

// A refused (not cancelled) record retries its release while still current.
func TestRefusedRecordRetriesItsReleaseWhileCurrent(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.capacity["run"], tr.refuseRelease = true, 1
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "capacity_exhausted")
	_, err = tr.c.Status(context.Background(), tr.spec)
	wantCode(t, err, "capacity_exhausted")
	if r, _ := tr.record(t, tr.spec); r.Cancelled || !r.terminal() || tr.leased || tr.count(tr.posts, "release") != 2 {
		t.Fatal("refused record did not retry its release", r.Release, tr.count(tr.posts, "release"))
	}
}

// While the older record still holds its lease, the newer attempt waits,
// retryably, and reaches nothing; once the release lands it proceeds.
func TestSupersedeWaitsForTheOldLease(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.capacity["run"], tr.refuseRelease = true, 2
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "capacity_exhausted")
	delete(tr.capacity, "run")
	next := nextAttempt(tr.spec)
	tr.current.Store(&next)
	if _, err = tr.c.Prepare(context.Background(), next, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("newer attempt did not wait for the old lease", err)
	}
	if tr.count(tr.posts, "lease") != 1 || !tr.leased {
		t.Fatal("newer attempt reached the producer while the old lease was held")
	}
	if _, err = tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("newer attempt did not proceed once the old lease was released", err)
	}
}

// The probe: a malformed release reply must not be replayed forever. The run
// is refused for capacity, the first release answers an unparseable 500, and
// the hub moves on; the next prepare resends the release and proceeds.
func TestMalformedReleaseReplyIsResent(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.capacity["run"], tr.malformedRelease = true, 1
	_, err := tr.c.Execute(context.Background(), tr.spec, admitAll)
	wantCode(t, err, "capacity_exhausted")
	if r, _ := tr.record(t, tr.spec); r.Release != "needed" || !tr.leased || tr.count(tr.posts, "release") != 1 {
		t.Fatal("fixture: the first release should have been malformed", r.Release)
	}
	delete(tr.capacity, "run")
	next := nextAttempt(tr.spec)
	tr.current.Store(&next)
	if _, err = tr.c.Prepare(context.Background(), next, tr.task); err != nil {
		t.Fatal("a malformed release reply blocked the bench", err)
	}
	if old, _ := tr.record(t, tr.spec); !old.terminal() || tr.count(tr.posts, "release") != 2 || tr.count(tr.effects, "release") != 1 {
		t.Fatal("release was not resent after a malformed reply", old.Release, tr.count(tr.posts, "release"))
	}
}

// An endlessly refused release keeps retrying and becomes visible in Status.
func TestEndlesslyRefusedReleaseIsVisible(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	tr.refuseRelease = 100
	var status benchcoordinator.Status
	var err error
	for i := 0; i < releaseWarnAfter+1; i++ {
		status, err = tr.c.Cancel(context.Background(), tr.spec)
	}
	r, _ := tr.record(t, tr.spec)
	if err != nil || status.State != "release_refused" || r.ReleaseFailures < releaseWarnAfter || !tr.leased || tr.count(tr.posts, "release") != releaseWarnAfter+1 {
		t.Fatal("a stuck release was silent or stopped retrying", status.State, r.ReleaseFailures, err)
	}
}
