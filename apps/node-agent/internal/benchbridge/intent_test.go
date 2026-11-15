package benchbridge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

func prepareFixture(t *testing.T) ([]byte, benchcoordinatorwire.Request) {
	t.Helper()
	raw, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Requests []struct{ Value json.RawMessage }
	}
	if json.Unmarshal(raw, &fixture) != nil || len(fixture.Requests) < 2 {
		t.Fatal("prepare fixture invalid")
	}
	request, err := benchcoordinatorwire.ParseRequest(fixture.Requests[1].Value)
	if err != nil {
		t.Fatal(err)
	}
	return fixture.Requests[1].Value, request
}

func intentChoice(r benchcoordinatorwire.Request) (benchdispatch.SourceSpec, benchdispatch.SourceTask) {
	timeout, err := taskTimeout(r.Task.TimeoutSeconds)
	if err != nil {
		panic("invalid task timeout in fixture")
	}
	task := benchdispatch.SourceTask{Arguments: []string{"/bin/sh"}, Environment: map[string]string{},
		Prompt: r.Task.Prompt, TimeoutSeconds: timeout, RepositoryName: r.Task.RepositoryName}
	spec := benchdispatch.SourceSpec{Identity: benchdispatch.Identity(*r.Identity), HostID: r.Target.HostID,
		BenchKey: "fixture", Holder: "fixture", ContextParent: "/private/context", DataRoot: "/private/data",
		WorkerPath: "/private/worker", WorkerSHA256: r.Target.WorkerSHA256, TaskSHA256: benchdispatch.SourceTaskSHA256(task),
		Create: true, CreateRequestID: "create_fixture", LeaseRequestID: "lease_fixture", RunRequestID: "run_fixture",
		CheckpointRepository: "api", Repositories: []benchdispatch.SourceRepository{{Name: "api", RepositorySHA256: r.Target.WorkerSHA256,
			TaskRef: "refs/heads/card/" + r.Identity.CardID, Base: "main", ObjectFormat: "sha1"}}}
	return spec, task
}

func intentStore(t *testing.T) IntentStore {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil || os.Chmod(root, 0700) != nil {
		t.Fatal("private fixture unavailable")
	}
	return IntentStore{Root: root}
}

func TestIntentFixesChoiceBeforeEffectsAndNeverRedecidesAfterRestart(t *testing.T) {
	s := intentStore(t)
	raw, request := prepareFixture(t)
	var choices, growth atomic.Int32
	choose := func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		choices.Add(1)
		spec, task := intentChoice(request)
		return spec, task, nil
	}
	first, err := s.Resolve(context.Background(), raw, choose)
	if err != nil || first.Spec == nil || !first.Spec.Create || first.Phase != "resolved" {
		t.Fatalf("choice not retained: %v", err)
	}
	// Simulate controller loss after choice but before effects. Status has no
	// discovery/growth callback; a new process reads the exact saved choice.
	restarted := IntentStore{Root: s.Root}
	read, err := restarted.Read(context.Background(), request)
	if err != nil || read.Spec == nil || !read.Spec.Create || read.PrepareSHA256 != rawSHA(raw) {
		t.Fatal("restart lost exact choice")
	}
	_, err = restarted.Resolve(context.Background(), raw, func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		choices.Add(1)
		spec, task := intentChoice(request)
		spec.Create = false // remote tips/registration may have changed meanwhile.
		return spec, task, nil
	})
	if err != nil || choices.Load() != 1 || growth.Load() != 0 {
		t.Fatal("restart re-decided choice or grew source")
	}
	claimed, err := restarted.ClaimEffects(context.Background(), raw)
	if err != nil || !claimed {
		t.Fatal("first handoff refused")
	}
	growth.Add(1)
	// Simulate loss after effects. Neither read nor another handoff starts work.
	if _, err = restarted.Read(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	claimed, err = restarted.ClaimEffects(context.Background(), raw)
	if err != nil || claimed || growth.Load() != 1 {
		t.Fatal("lost reply authorized extra growth")
	}
}

func TestIntentConcurrentHandoffIsOnceOnly(t *testing.T) {
	s := intentStore(t)
	raw, request := prepareFixture(t)
	_, err := s.Resolve(context.Background(), raw, func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		spec, task := intentChoice(request)
		return spec, task, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var claims atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			claimed, err := s.ClaimEffects(context.Background(), raw)
			if err != nil {
				t.Error(err)
			}
			if claimed {
				claims.Add(1)
			}
		})
	}
	wg.Wait()
	if claims.Load() != 1 {
		t.Fatal("concurrent handoff was not exactly once")
	}
}

func TestMissingCorruptOrChangedIntentNeverCallsChooser(t *testing.T) {
	s := intentStore(t)
	raw, request := prepareFixture(t)
	if _, err := s.Read(context.Background(), request); !errors.Is(err, ErrIntent) {
		t.Fatal("missing intent looked authorized")
	}
	path := filepath.Join(s.Root, intentName(*request.Identity)+".json")
	if err := os.WriteFile(path, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	var called bool
	_, err := s.Resolve(context.Background(), raw, func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		called = true
		return benchdispatch.SourceSpec{}, benchdispatch.SourceTask{}, nil
	})
	if !errors.Is(err, ErrIntent) || called {
		t.Fatal("corruption became fresh source work")
	}
	if _, err = s.Read(context.Background(), request); !errors.Is(err, ErrIntent) {
		t.Fatal("corruption was projected")
	}
}

func TestIntentRejectsSameOwnerChangedTask(t *testing.T) {
	s := intentStore(t)
	raw, request := prepareFixture(t)
	_, err := s.Resolve(context.Background(), raw, func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		spec, task := intentChoice(request)
		return spec, task, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	request.Task.Prompt = "substituted"
	changed, _ := json.Marshal(request)
	_, err = s.Resolve(context.Background(), changed, func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		t.Error("changed prompt reached chooser")
		return benchdispatch.SourceSpec{}, benchdispatch.SourceTask{}, nil
	})
	if !errors.Is(err, ErrIntent) {
		t.Fatal("same owner replaced immutable task")
	}
}

func TestIntentExecutionRetainsExactAdmissionAndNeverLaunchesTwice(t *testing.T) {
	s := intentStore(t)
	raw, request := prepareFixture(t)
	_, err := s.Resolve(context.Background(), raw, func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		spec, task := intentChoice(request)
		return spec, task, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Requests []struct{ Value json.RawMessage }
	}
	if json.Unmarshal(fixture, &corpus) != nil {
		t.Fatal("fixture invalid")
	}
	executionRaw := append([]byte("\n "), corpus.Requests[2].Value...)
	executionRaw = append(executionRaw, '\n')
	execution, err := benchcoordinatorwire.ParseRequest(executionRaw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ClaimExecution(context.Background(), executionRaw); !errors.Is(err, ErrIntent) {
		t.Fatal("execution preceded source effects handoff")
	}
	if claimed, err := s.ClaimEffects(context.Background(), raw); err != nil || !claimed {
		t.Fatal("prepare handoff failed")
	}
	if claimed, err := s.ClaimExecution(context.Background(), executionRaw); err != nil || !claimed {
		t.Fatalf("execution handoff failed: %v", err)
	}
	restarted := IntentStore{Root: s.Root}
	saved, err := restarted.Read(context.Background(), execution)
	if err != nil || saved.ExecuteRequest != string(executionRaw) || saved.ExecuteSHA256 != rawSHA(executionRaw) {
		t.Fatal("restart lost exact admission body")
	}
	if claimed, err := restarted.ClaimExecution(context.Background(), executionRaw); err != nil || claimed {
		t.Fatal("lost reply launched another child")
	}
	// Semantically equivalent JSON is still another raw request; the admitted
	// receipt and immutable exact launch request must not be replaced after loss.
	changed, err := json.Marshal(execution)
	if err != nil {
		t.Fatal(err)
	}
	if claimed, err := restarted.ClaimExecution(context.Background(), changed); !errors.Is(err, ErrIntent) || claimed {
		t.Fatal("changed execution body replaced retained admission")
	}
}
