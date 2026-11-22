package benchbridge

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// A stage whose cards choose their repositories: the registry holds the whole
// allow-list with its clone URLs, and each prepare names the card's choice.

var allowList = []LocalRepository{
	{Name: "api", Repository: "/fixture/api", Base: "main", ObjectFormat: "sha1"},
	{Name: "app", Repository: "/fixture/app", Base: "main", ObjectFormat: "sha1"},
	{Name: "docs", Repository: "/fixture/docs", Base: "trunk", ObjectFormat: "sha256"},
}

// existing is the card's bench as SuperBench reports it: nil when it has none.
type existing struct {
	members []string
	start   string
}

// choiceHandler answers only status, with the card's bench or not_found.
func choiceHandler(t *testing.T, bench *existing) *Handler {
	t.Helper()
	_, registry := registryFixture(t)
	_, request := prepareFixture(t)
	registry.WorkerSHA256 = request.Target.WorkerSHA256
	registry.Profiles[0].Repositories = append([]LocalRepository(nil), allowList...)
	registry.Profiles[0].CheckpointRepository = "app"
	dir, err := os.MkdirTemp("", "bbc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "s")
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	absent := corpusFailure(t, "error-404-not_found")
	server := &http.Server{ReadHeaderTimeout: time.Minute, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req benchworkspace.Request
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Operation != "status" {
			t.Error("choose sent", req.Operation)
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if bench == nil {
			w.WriteHeader(absent.status)
			_, _ = w.Write(absent.body)
			return
		}
		seal := strings.Repeat("a", 40)
		members, sealed := []any{}, []any{}
		for _, name := range bench.members {
			members = append(members, map[string]string{"name": name, "branch": "card/x", "base": "main", "object_format": "sha1", "source_commit": seal})
			sealed = append(sealed, map[string]string{"name": name, "commit": seal})
		}
		ws := map[string]any{"kind": "workspace", "key": req.Key, "bench_id": strings.Repeat("1", 32), "phase": "ready",
			"member_count": len(bench.members), "checkpoint_repository": bench.start, "ready_for_acquisition": true,
			"quota_bytes": 1 << 30, "quota_inodes": 1 << 20, "members": members,
			"checkpoint": map[string]any{"generation_id": strings.Repeat("2", 32), "seal": seal, "manifest_sha256": strings.Repeat("c", 64), "members": sealed}}
		raw, _ := json.Marshal(map[string]any{"version": benchworkspace.Version, "operation": "status", "ok": true, "result": map[string]any{"benches": []any{ws}}})
		_, _ = w.Write(raw)
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client, err := benchworkspace.NewClient(socket, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return &Handler{registry: registry, client: client}
}

func choiceRequest(t *testing.T, start string, names ...string) benchcoordinatorwire.Request {
	t.Helper()
	_, request := prepareFixture(t)
	task := *request.Task
	task.RepositoryName, task.RepositoryNames = start, names
	request.Task = &task
	return request
}

func specNames(spec benchdispatch.SourceSpec) []string {
	out := []string{}
	for _, r := range spec.Repositories {
		out = append(out, r.Name)
	}
	return out
}

func TestPrepareHoldsOnlyTheCardsRepositories(t *testing.T) {
	h := choiceHandler(t, nil)
	request := choiceRequest(t, "docs", "api", "docs")
	p := h.registry.Profiles[0]
	spec, task, err := h.choose(context.Background(), request, p)
	if err != nil {
		t.Fatal(err)
	}
	if got := specNames(spec); !reflect.DeepEqual(got, []string{"api", "docs"}) || spec.CheckpointRepository != "docs" || !spec.Create {
		t.Fatalf("spec names %v start %q create %v", got, spec.CheckpointRepository, spec.Create)
	}
	if spec.Repositories[1].Base != "trunk" || spec.Repositories[1].ObjectFormat != "sha256" ||
		spec.Repositories[1].RepositorySHA256 != rawSHA([]byte("/fixture/docs")) || task.RepositoryName != "docs" {
		t.Fatal("a chosen member lost its registry identity", spec.Repositories[1])
	}
	// The coordinator gets the same members, with their private clone identities, filtered by name.
	got := attemptRepositories(p, &spec)
	if !reflect.DeepEqual(got, []LocalRepository{allowList[0], allowList[2]}) {
		t.Fatal("coordinator repositories", got)
	}
	// The bench key stays per card: a choice does not change it.
	whole, _, err := h.choose(context.Background(), choiceRequest(t, "app"), p)
	if err != nil || whole.BenchKey != spec.BenchKey {
		t.Fatal("bench key changed with the choice", err)
	}
}

func TestPrepareWithoutAChoiceKeepsTheWholeProfile(t *testing.T) {
	h := choiceHandler(t, nil)
	p := h.registry.Profiles[0]
	spec, _, err := h.choose(context.Background(), choiceRequest(t, "app"), p)
	if err != nil {
		t.Fatal(err)
	}
	if got := specNames(spec); !reflect.DeepEqual(got, []string{"api", "app", "docs"}) || spec.CheckpointRepository != "app" {
		t.Fatal("a fixed stage's prepare changed", got, spec.CheckpointRepository)
	}
	if !reflect.DeepEqual(attemptRepositories(p, &spec), allowList) || !reflect.DeepEqual(attemptRepositories(p, nil), allowList) {
		t.Fatal("a fixed stage's coordinator lost a repository")
	}
}

func refusalOfChoice(t *testing.T, err error) string {
	t.Helper()
	code, ok := benchlaunch.RefusalCode(err)
	if !ok || code != "unsupported" {
		t.Fatalf("not a terminal unsupported refusal: %v", err)
	}
	return benchlaunch.RefusalMessage(err)
}

func TestAnExistingBenchWithAnotherSetIsRefused(t *testing.T) {
	for _, c := range []struct {
		name  string
		bench existing
	}{
		{"fewer members", existing{[]string{"api"}, "api"}},
		{"same count, other members", existing{[]string{"api", "app"}, "api"}},
		{"same members, other start", existing{[]string{"api", "docs"}, "api"}},
	} {
		h := choiceHandler(t, &c.bench)
		_, _, err := h.choose(context.Background(), choiceRequest(t, "docs", "api", "docs"), h.registry.Profiles[0])
		message := refusalOfChoice(t, err)
		if !strings.Contains(message, "fixed once its bench exists") || !strings.Contains(message, strings.Join(c.bench.members, ", ")) {
			t.Fatal(c.name, message)
		}
		response, wireErr := failed(choiceRequest(t, "docs", "api", "docs"), err)
		if wireErr != nil || response.State != "refused" || response.Code != "unsupported" || response.Detail == nil || response.Detail.Message != message {
			t.Fatal(c.name, "the refusal does not reach the hub named", response, wireErr)
		}
	}
	// The same choice leases the card's bench as before.
	h := choiceHandler(t, &existing{[]string{"api", "docs"}, "docs"})
	spec, _, err := h.choose(context.Background(), choiceRequest(t, "docs", "api", "docs"), h.registry.Profiles[0])
	if err != nil || spec.Create {
		t.Fatal("the same choice did not reuse the bench", err)
	}
}

func TestAChoiceTheRegistryDoesNotServeIsRefused(t *testing.T) {
	h := choiceHandler(t, nil)
	for _, request := range []benchcoordinatorwire.Request{
		choiceRequest(t, "api", "api", "mobile"),
		choiceRequest(t, "app", "api", "docs"),
	} {
		if _, _, err := h.choose(context.Background(), request, h.registry.Profiles[0]); err == nil {
			t.Fatal("served a choice outside the registry", request.Task.RepositoryNames)
		} else {
			refusalOfChoice(t, err)
		}
	}
}

// Resolve passes a terminal choice refusal on, recording no choice, so the
// handler answers it instead of parking the prepare as pending.
func TestResolveAnswersAChoiceRefusal(t *testing.T) {
	h := choiceHandler(t, &existing{[]string{"api"}, "api"})
	raw, request := prepareFixture(t)
	s := intentStore(t)
	chosen := choiceRequest(t, "docs", "api", "docs")
	_, err := s.Resolve(context.Background(), raw, func(ctx context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		return h.choose(ctx, chosen, h.registry.Profiles[0])
	})
	refusalOfChoice(t, err)
	if intent, err := s.Read(context.Background(), request); err != nil || intent.Phase != "reserved" || intent.Spec != nil {
		t.Fatal("a refused choice was recorded")
	}
}

func TestTheWireCarriesACardsChoice(t *testing.T) {
	raw, _ := prepareFixture(t)
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	with := func(start string, names ...any) []byte {
		task := map[string]any{}
		for k, v := range value["task"].(map[string]any) {
			task[k] = v
		}
		task["repository_name"] = start
		if names != nil {
			task["repository_names"] = names
		}
		request := map[string]any{}
		for k, v := range value {
			request[k] = v
		}
		request["task"] = task
		out, _ := json.Marshal(request)
		return out
	}
	if r, err := benchcoordinatorwire.ParseRequest(with("docs", "api", "docs")); err != nil || !reflect.DeepEqual(r.Task.RepositoryNames, []string{"api", "docs"}) {
		t.Fatal("a valid choice was refused", err)
	}
	for _, bad := range [][]byte{
		with("app", "api", "docs"),  // the start is not chosen
		with("docs", "docs", "api"), // not sorted
		with("api", "api", "api"),   // repeated
		with("api", []any{}...),     // empty
		with("api", "API"),          // not a name
	} {
		if _, err := benchcoordinatorwire.ParseRequest(bad); err == nil {
			t.Fatal("accepted", string(bad))
		}
	}
}
