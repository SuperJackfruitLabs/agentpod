package benchdispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func executeFixture(t *testing.T) (*sourceTrial, Plan, AdmissionGate) {
	t.Helper()
	trial := sourceFixture(t, false)
	p, e := trial.coordinator.Prepare(t.Context(), trial.spec, trial.task)
	if e != nil {
		t.Fatal(e)
	}
	expected, e := trial.coordinator.Binding(t.Context(), trial.spec)
	if e != nil {
		t.Fatal(e)
	}
	frozen, _ := json.Marshal(expected)
	gate := func(_ context.Context, b SourceBinding) error {
		raw, _ := json.Marshal(b)
		if !bytes.Equal(raw, frozen) {
			return ErrOwner
		}
		return nil
	}
	trial.intercept = func(w http.ResponseWriter, _ *http.Request, r benchworkspace.Request) bool {
		if r.Operation != "run" {
			return false
		}
		if len(r.Arguments) != 3 || r.Arguments[2] != p.ContextSHA256 || r.LeaseToken != strings.Repeat("d", 48) {
			t.Error("changed original run")
		}
		result := superbench.WorkerResult{Version: superbench.GroupedWorkerVersion, Binding: superbench.Binding{BoardID: p.Identity.BoardID, CardID: p.Identity.CardID, RunID: p.Identity.RunID, Epoch: p.Identity.Epoch}, Outcome: "complete", Handoff: map[string]string{"code": "pushed"}}
		raw, _ := json.Marshal(result)
		if e := writeAtomic(p.ContextPath, "result.json", raw); e != nil {
			t.Error(e)
		}
		zero := 0
		run := &benchworkspace.RunOutcome{Mutation: benchworkspace.Mutation{Workspace: benchworkspace.Workspace{Key: p.BenchKey, BenchID: p.RegistrationID, Phase: "ready", MemberCount: 2, CheckpointRepository: "a", ReadyForAcquisition: true, QuotaBytes: 64 << 20, QuotaInodes: 4096, Checkpoint: &benchworkspace.Checkpoint{GenerationID: strings.Repeat("f", 32), ManifestSHA256: strings.Repeat("a", 64), Seal: strings.Repeat("b", 40), Members: []benchworkspace.Commit{{Name: "a", Commit: strings.Repeat("c", 40)}, {Name: "b", Commit: strings.Repeat("d", 64)}}}}}, Execution: &benchworkspace.Execution{ID: strings.Repeat("e", 32), Phase: "stopped"}, ExitCode: &zero}
		response := benchworkspace.Response{Version: benchworkspace.Version, Operation: "run", RequestID: r.RequestID, OK: true, Result: run}
		raw, _ = json.Marshal(response)
		if _, e := benchworkspace.ParseResponse(raw, 200, r); e != nil {
			t.Error(e)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
		return true
	}
	return trial, p, gate
}

func TestExecuteBoundConcreteOnceAndReplay(t *testing.T) {
	trial, p, admit := executeFixture(t)
	raw, e := trial.coordinator.ExecuteBound(t.Context(), trial.spec, admit)
	if e != nil {
		t.Fatal(e)
	}
	var proposal Proposal
	if json.Unmarshal(raw, &proposal) != nil || proposal.Observation.ExecutionID != strings.Repeat("e", 32) || proposal.Observation.Checkpoints[0].Commit == p.Sources[0].Commit {
		t.Fatal("missing actual final evidence")
	}
	// Proposals remain private Plan-containing ledger records; only the
	// separately tested SourceBinding is suitable for a shared projection.
	for _, secret := range []string{`"lease_token"`, `"` + strings.Repeat("d", 48) + `"`, "private task", "/authorized/"} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatal("capability/task data leaked")
		}
	}

	again, e := trial.coordinator.ExecuteBound(t.Context(), trial.spec, admit)
	if e != nil || !bytes.Equal(raw, again) || trial.count("run") != 1 {
		t.Fatalf("replay %v sends=%d", e, trial.count("run"))
	}
}

func TestExecuteBoundRequiresAdmissionAndOriginalContext(t *testing.T) {
	trial, p, _ := executeFixture(t)
	for _, gate := range []AdmissionGate{nil, func(context.Context, SourceBinding) error { return ErrOwner }} {
		if _, e := trial.coordinator.ExecuteBound(t.Context(), trial.spec, gate); e == nil {
			t.Fatal("unadmitted launch")
		}
	}
	if trial.count("run") != 0 {
		t.Fatal("sent before admission")
	}
	f, e := os.OpenRoot(p.ContextPath)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if e = f.WriteFile("request.json", []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = trial.coordinator.ExecuteBound(t.Context(), trial.spec, func(context.Context, SourceBinding) error { return nil }); e == nil || trial.count("run") != 0 {
		t.Fatal("changed context launched")
	}
}

func TestExecuteBoundLostReplyNeverRedispatches(t *testing.T) {
	trial, _, admit := executeFixture(t)
	trial.intercept = func(w http.ResponseWriter, _ *http.Request, r benchworkspace.Request) bool {
		if r.Operation != "run" {
			return false
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{"))
		return true
	}
	for range 2 {
		if _, e := trial.coordinator.ExecuteBound(t.Context(), trial.spec, admit); !errors.Is(e, ErrPending) {
			t.Fatal(e)
		}
	}
	if trial.count("run") != 1 {
		t.Fatal("lost reply redispatched")
	}
}

func TestExecuteBoundReconcilesCapturedReplyAfterPostAwaitRevocation(t *testing.T) {
	trial, p, admit := executeFixture(t)
	original := trial.intercept
	allowed := true
	trial.intercept = func(w http.ResponseWriter, r *http.Request, request benchworkspace.Request) bool {
		handled := original(w, r, request)
		allowed = false
		return handled
	}
	trial.coordinator.Current = func(context.Context, SourceSpec) error {
		if !allowed {
			return ErrOwner
		}
		return nil
	}
	if _, e := trial.coordinator.ExecuteBound(t.Context(), trial.spec, admit); e == nil {
		t.Fatal("revoked owner proposed")
	}
	if _, e := os.Stat(filepath.Join(trial.coordinator.Store.Root, sourceFile(trial.spec, "run", ".response"))); e != nil {
		t.Fatal("reply not retained", e)
	}
	allowed = true
	if _, e := trial.coordinator.ExecuteBound(t.Context(), trial.spec, admit); e != nil || trial.count("run") != 1 {
		t.Fatalf("reconcile %v sends=%d context=%s", e, trial.count("run"), filepath.Base(p.ContextPath))
	}
}

func TestExecuteBoundRejectsIncompleteOrForeignProducerProof(t *testing.T) {
	for _, kind := range []string{"foreign-bench", "missing-exit", "wrong-format", "missing-worker", "foreign-worker"} {
		t.Run(kind, func(t *testing.T) {
			trial, p, admit := executeFixture(t)
			original := trial.intercept
			trial.intercept = func(w http.ResponseWriter, r *http.Request, request benchworkspace.Request) bool {
				recorded := httptest.NewRecorder()
				if !original(recorded, r, request) {
					return false
				}
				var response benchworkspace.Response
				// Decode typed body through the real strict parser before controlled corruption.
				reply, e := benchworkspace.ParseResponse(recorded.Body.Bytes(), 200, request)
				if e != nil {
					t.Fatal(e)
				}
				response = reply
				run, ok := response.Result.(*benchworkspace.RunOutcome)
				if !ok {
					t.Fatal("not run")
				}
				switch kind {
				case "foreign-bench":
					run.Workspace.BenchID = strings.Repeat("a", 32)
				case "missing-exit":
					run.ExitCode = nil
				case "wrong-format":
					run.Workspace.Checkpoint.Members[0].Commit = strings.Repeat("a", 64)
				case "missing-worker":
					if e := os.Remove(filepath.Join(p.ContextPath, "result.json")); e != nil {
						t.Error(e)
					}
				case "foreign-worker":
					raw, _ := json.Marshal(superbench.WorkerResult{Version: superbench.GroupedWorkerVersion, Binding: superbench.Binding{BoardID: "foreign", CardID: p.Identity.CardID, RunID: p.Identity.RunID, Epoch: p.Identity.Epoch}, Outcome: "complete", Handoff: map[string]string{}})
					if e := writeAtomic(p.ContextPath, "result.json", raw); e != nil {
						t.Error(e)
					}
				}
				raw, _ := json.Marshal(response)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(raw)
				return true
			}
			for range 2 {
				if _, e := trial.coordinator.ExecuteBound(t.Context(), trial.spec, admit); e == nil {
					t.Fatal("invalid proof proposed")
				}
			}
			if trial.count("run") != 1 {
				t.Fatal("invalid proof redispatched")
			}
		})
	}
}

func TestSourceBindingProjectionHasNoPrivateTransportData(t *testing.T) {
	trial, p, _ := executeFixture(t)
	b, e := trial.coordinator.Binding(t.Context(), trial.spec)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(b)
	for _, private := range []string{p.ContextPath, p.Grouped.WorkspaceRoot, `"lease_token"`, "/authorized/", "private task"} {
		if bytes.Contains(raw, []byte(private)) {
			t.Fatal("private binding data")
		}
	}
	if len(SourceBindingSHA256(b)) != 64 || b.Checkpoint.GenerationID == "" || len(b.Operations) != 2 || b.Operations[1].ResponseSHA256 == "" {
		t.Fatal("missing preserved source identity")
	}
}

func TestExecuteBoundRechecksCurrentAfterFinalAdmissionAwait(t *testing.T) {
	trial, _, _ := executeFixture(t)
	allowed, calls := true, 0
	trial.coordinator.Current = func(context.Context, SourceSpec) error {
		if !allowed {
			return ErrOwner
		}
		return nil
	}
	admit := func(context.Context, SourceBinding) error {
		calls++
		if calls == 4 {
			allowed = false
		}
		return nil
	}
	if _, e := trial.coordinator.ExecuteBound(t.Context(), trial.spec, admit); !errors.Is(e, ErrOwner) {
		t.Fatalf("final admission revoked current owner: %v (calls=%d)", e, calls)
	}
	if trial.count("run") != 1 {
		t.Fatal("unexpected execution count")
	}
	allowed = true
	if _, e := trial.coordinator.ExecuteBound(t.Context(), trial.spec, admit); e != nil || trial.count("run") != 1 {
		t.Fatal("could not reconcile original evidence", e)
	}
}
