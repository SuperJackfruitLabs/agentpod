package benchcoordinator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func hash(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
func completionFixture(t *testing.T) (benchdispatch.SourceCoordinator, benchdispatch.SourceSpec, benchdispatch.Plan, *atomic.Int32) {
	return completionFixtureWith(t, false, nil)
}
func completionFixtureWith(t *testing.T, unprepared bool, intercept func(http.ResponseWriter, []byte) bool) (benchdispatch.SourceCoordinator, benchdispatch.SourceSpec, benchdispatch.Plan, *atomic.Int32) {
	t.Helper()
	parent, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Chmod(parent, 0700); e != nil {
		t.Fatal(e)
	}
	worker := filepath.Join(parent, "worker")
	binary := []byte("#!/bin/sh\nexit 0\n")
	if e = os.WriteFile(worker, binary, 0700); e != nil {
		t.Fatal(e)
	}
	data := filepath.Join(parent, "data")
	root := filepath.Join(data, "benches", "card-bench")
	if e = os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	identity := benchdispatch.Identity{TenantID: "tenant", BoardID: "brd_example1", CardID: "card_example1", StageID: "write", RunID: "run_example1", Epoch: 3, AgentID: "executor", StationID: "station", NodeID: "node", AttemptID: "attempt", ControlPrincipalID: "principal", ControlGrantID: "grant", PolicySHA256: hash([]byte("policy"))}
	task := benchdispatch.SourceTask{Arguments: []string{"/bin/sh", "-c", "exit 0"}, Prompt: "private task", Environment: map[string]string{}, TimeoutSeconds: 30}
	spec := benchdispatch.SourceSpec{Identity: identity, HostID: "host", BenchKey: "card-bench", Holder: "board/run/3", ContextParent: parent, DataRoot: data, CheckpointRepository: "a", WorkerPath: worker, WorkerSHA256: hash(binary), TaskSHA256: benchdispatch.SourceTaskSHA256(task), LeaseRequestID: "source-lease", RunRequestID: "source-run", Repositories: []benchdispatch.SourceRepository{{Name: "a", RepositorySHA256: hash([]byte("/authorized/a")), TaskRef: "refs/heads/card/card_example1", Base: "main", ObjectFormat: "sha1"}}}
	socketDir, e := os.MkdirTemp("/tmp", "completion-")
	if e != nil {
		t.Fatal(e)
	}
	listener, e := (&net.ListenConfig{}).Listen(t.Context(), "unix", filepath.Join(socketDir, "api.sock"))
	if e != nil {
		t.Fatal(e)
	}
	runs := new(atomic.Int32)
	server := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(io.LimitReader(r.Body, benchworkspace.MaxBody+1))
		if err != nil {
			t.Error(err)
			return
		}
		if intercept != nil && intercept(w, raw) {
			return
		}
		req, err := benchworkspace.Parse(raw)
		if err != nil {
			t.Error(err)
			return
		}
		cp := &benchworkspace.Checkpoint{GenerationID: strings.Repeat("c", 32), ManifestSHA256: strings.Repeat("d", 64), Seal: strings.Repeat("e", 40), Members: []benchworkspace.Commit{{Name: "a", Commit: strings.Repeat("a", 40)}}}
		mutation := benchworkspace.Mutation{Workspace: benchworkspace.Workspace{Key: spec.BenchKey, BenchID: strings.Repeat("b", 32), Phase: "ready", MemberCount: 1, CheckpointRepository: "a", QuotaBytes: 32 << 20, QuotaInodes: 4096, Checkpoint: cp, Lease: &benchworkspace.LeaseSummary{Holder: spec.Holder, Mode: "cooperative"}}}
		var result benchworkspace.Result = &mutation
		switch req.Operation {
		case "lease":
			mutation.RootPath = root
			mutation.Grant = &benchworkspace.Grant{LeaseToken: hash([]byte("private lease token"))[:48]}
		case "checkpoint":
		case "run":
			runs.Add(1)
			binding := superbench.Binding{BoardID: identity.BoardID, CardID: identity.CardID, RunID: identity.RunID, Epoch: identity.Epoch}
			out, _ := json.Marshal(superbench.WorkerResult{Version: superbench.GroupedWorkerVersion, Binding: binding, Outcome: "complete", Handoff: map[string]string{"code": "Untrusted task text https://example.test/file /task/file"}})
			if err = os.WriteFile(filepath.Join(req.Arguments[1], "result.json"), out, 0600); err != nil {
				t.Error(err)
			}
			mutation.Workspace.Lease = nil
			mutation.Workspace.ReadyForAcquisition = true
			cp.Members[0].Commit = strings.Repeat("f", 40)
			zero := 0
			result = &benchworkspace.RunOutcome{Mutation: mutation, Execution: &benchworkspace.Execution{ID: strings.Repeat("e", 32), Phase: "stopped"}, ExitCode: &zero}
		default:
			t.Error("unexpected operation", req.Operation)
		}
		response := benchworkspace.Response{Version: benchworkspace.Version, Operation: req.Operation, RequestID: req.RequestID, OK: true, Result: result}
		body, _ := json.Marshal(response)
		if _, err = benchworkspace.ParseResponse(body, 200, req); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})}
	done := make(chan struct{})
	go func() { defer close(done); _ = server.Serve(listener) }()
	client, e := benchworkspace.NewClient(filepath.Join(socketDir, "api.sock"), time.Second)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { client.Close(); _ = server.Close(); <-done; _ = os.RemoveAll(socketDir) })
	c := benchdispatch.SourceCoordinator{Store: benchdispatch.Store{Root: filepath.Join(parent, "ledger")}, Client: client, Repositories: []benchworkspace.Repository{{Name: "a", Repository: "/authorized/a", Branch: "card/card_example1", Base: "main"}}, ContextParent: parent, Current: func(context.Context, benchdispatch.SourceSpec) error { return nil }}
	var p benchdispatch.Plan
	if !unprepared {
		p, e = c.Prepare(t.Context(), spec, task)
		if e != nil {
			t.Fatal(e)
		}
	}
	return c, spec, p, runs
}

func TestCompletedProjectionReparsesExactHistoricalEvidence(t *testing.T) {
	c, spec, p, runs := completionFixture(t)
	if _, e := ReadCompletion(t.Context(), c.Store, spec); !errors.Is(e, benchdispatch.ErrPending) {
		t.Fatal("unexecuted projected", e)
	}
	if _, e := c.ExecuteBound(t.Context(), spec, func(context.Context, benchdispatch.SourceBinding) error { return nil }); e != nil {
		t.Fatal(e)
	}
	got, e := ReadCompletion(t.Context(), c.Store, spec)
	if e != nil {
		t.Fatal(e)
	}
	if got.Source.Checkpoint.Members[0].Commit == got.Service.Checkpoints[0].Commit || got.Task.Outcome != "complete" || got.Service.ExecutionID != strings.Repeat("e", 32) {
		t.Fatal("not actual final evidence")
	}
	raw, _ := json.Marshal(got)
	for _, private := range []string{p.ContextPath, p.Grouped.WorkspaceRoot, p.ExecutablePath, hash([]byte("private lease token"))[:48], "/authorized/a", `"plan"`, `"lease_token"`} {
		if strings.Contains(string(raw), private) {
			t.Fatal("private metadata projected", private)
		}
	}
	if !strings.Contains(string(raw), "https://example.test/file /task/file") {
		t.Fatal("untrusted task output silently sanitized")
	}
	again, e := ReadCompletion(t.Context(), c.Store, spec)
	b, _ := json.Marshal(again)
	if e != nil || string(raw) != string(b) || runs.Load() != 1 {
		t.Fatal("projection changed or relaunched", e)
	}
	other := spec
	other.Identity.Epoch++
	if _, e = ReadCompletion(t.Context(), c.Store, other); e == nil {
		t.Fatal("foreign attempt disclosed")
	}
	responses, e := filepath.Glob(filepath.Join(c.Store.Root, "*-run.response"))
	if e != nil || len(responses) != 1 {
		t.Fatal("missing preserved run response", e)
	}
	ledgerRoot, e := os.OpenRoot(c.Store.Root)
	if e != nil {
		t.Fatal(e)
	}
	defer ledgerRoot.Close()
	original, e := ledgerRoot.ReadFile(filepath.Base(responses[0]))
	if e != nil {
		t.Fatal(e)
	}
	if e = ledgerRoot.WriteFile(filepath.Base(responses[0]), append(append([]byte(nil), original...), ' '), 0600); e != nil {
		t.Fatal(e)
	}
	if bad, err := ReadCompletion(t.Context(), c.Store, spec); err == nil || bad.Service.ExecutionID != "" || runs.Load() != 1 {
		t.Fatal("changed valid response projected or redispatched", err)
	}
	if e = ledgerRoot.WriteFile(filepath.Base(responses[0]), original, 0600); e != nil {
		t.Fatal(e)
	}
	contextRoot, e := os.OpenRoot(p.ContextPath)
	if e != nil {
		t.Fatal(e)
	}
	defer contextRoot.Close()
	original, e = contextRoot.ReadFile("result.json")
	if e != nil {
		t.Fatal(e)
	}
	if e = contextRoot.WriteFile("result.json", append(original, ' '), 0600); e != nil {
		t.Fatal(e)
	}
	if _, err := ReadCompletion(t.Context(), c.Store, spec); err == nil || runs.Load() != 1 {
		t.Fatal("changed valid worker bytes accepted", err)
	}
	if e = contextRoot.WriteFile("result.json", []byte(`{}`), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = ReadCompletion(t.Context(), c.Store, spec); e == nil || runs.Load() != 1 {
		t.Fatal("changed worker result accepted or redispatched", e)
	}
}
