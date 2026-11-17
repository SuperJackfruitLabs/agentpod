package benchlaunch

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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
	c     Coordinator
	spec  benchdispatch.SourceSpec
	task  benchdispatch.SourceTask
	stale atomic.Bool
	dir   string
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
	return tr
}

// coordinator builds a fresh instance over the same journal: a Node restart.
func (tr *trial) coordinator(repos []benchworkspace.Repository) Coordinator {
	return Coordinator{Journal: Journal{Root: tr.dir}, Producer: tr.fakeBench, Repositories: repos, Current: func(context.Context, benchdispatch.SourceSpec) error {
		if tr.stale.Load() {
			return errors.New("stale")
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

func TestSecondAttemptOnABusyBenchIsRefused(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	other := tr.spec
	other.Identity.RunID, other.Identity.AttemptID, other.Holder = "run_run002", "attempt-2", "cp_other"
	_, err := tr.c.Prepare(context.Background(), other, tr.task)
	wantCode(t, err, "conflict")
	if tr.count(tr.posts, "lease") != 1 {
		t.Fatal("a second attempt reached the producer")
	}
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
	if !isRefusal(err, "unsupported") && !isRefusal(err, "verification_failed") {
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
