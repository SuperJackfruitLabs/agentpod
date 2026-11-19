package benchbridge

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// statusProducer answers only status, with one workspace in the given phase.
// Any other operation fails the test: choose is read-only. Phase "absent" is
// a key SuperBench has no bench for and "unavailable" a producer that cannot
// answer; both reply with the shared response corpus's error, as the contract
// requires of a specific-key status (that key's record or not_found, never an
// empty inventory).
type statusProducer struct {
	mu    sync.Mutex
	phase string
	ops   map[string]int
}

func (p *statusProducer) count(op string) int { p.mu.Lock(); defer p.mu.Unlock(); return p.ops[op] }

func reclaimHandler(t *testing.T, phase string) (*Handler, *statusProducer) {
	t.Helper()
	_, registry := registryFixture(t)
	// The intent binds the chosen spec to the prepare's target worker.
	_, request := prepareFixture(t)
	registry.WorkerSHA256 = request.Target.WorkerSHA256
	dir, err := os.MkdirTemp("", "bbr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "s")
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	failures := map[string]statusFailure{"absent": corpusFailure(t, "error-404-not_found"), "unavailable": corpusFailure(t, "error-503-unavailable")}
	producer := &statusProducer{phase: phase, ops: map[string]int{}}
	server := &http.Server{ReadHeaderTimeout: time.Minute, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request benchworkspace.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		producer.mu.Lock()
		producer.ops[request.Operation]++
		phase := producer.phase
		producer.mu.Unlock()
		if request.Operation != "status" {
			t.Error("choose sent", request.Operation)
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if f, ok := failures[phase]; ok {
			w.WriteHeader(f.status)
			_, _ = w.Write(f.body)
			return
		}
		seal := strings.Repeat("a", 40)
		bench := map[string]any{"kind": "workspace", "key": request.Key, "bench_id": strings.Repeat("1", 32), "phase": phase,
			"member_count": 1, "checkpoint_repository": "api", "ready_for_acquisition": phase == "ready", "quota_bytes": 1 << 30, "quota_inodes": 1 << 20,
			"checkpoint": map[string]any{"generation_id": strings.Repeat("2", 32), "seal": seal, "manifest_sha256": strings.Repeat("c", 64), "members": []any{map[string]string{"name": "api", "commit": seal}}},
			"members":    []any{map[string]string{"name": "api", "branch": "card/x", "base": "main", "object_format": "sha1", "source_commit": seal}}}
		if phase == "materializing" || phase == "initializing" {
			// A create that never finished: no checkpoint, held by its initialization owner.
			delete(bench, "checkpoint")
			bench["lease"] = map[string]any{"holder": "initialization", "mode": "supervised", "stop_requested": false, "execution": map[string]string{"id": strings.Repeat("3", 32), "phase": "stopped"}}
		}
		raw, _ := json.Marshal(map[string]any{"version": benchworkspace.Version, "operation": "status", "ok": true, "result": map[string]any{"benches": []any{bench}}})
		_, _ = w.Write(raw)
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client, err := benchworkspace.NewClient(socket, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return &Handler{registry: registry, client: client}, producer
}

type statusFailure struct {
	status int
	body   []byte
}

// corpusFailure takes a named error case from the SuperBench response corpus
// (testdata copied from the contract's fixtures/superbench-api) and answers it
// to a specific-key status. The corpus states errors on a lease; only the
// operation and request_id change, and the parser must still accept it.
func corpusFailure(t *testing.T, name string) statusFailure {
	t.Helper()
	raw, err := os.ReadFile("../benchworkspace/testdata/workspace-responses.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Valid []struct {
			Name   string
			Status int
			Body   map[string]any
		}
	}
	if err = json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, c := range corpus.Valid {
		if c.Name != name {
			continue
		}
		c.Body["operation"] = "status"
		delete(c.Body, "request_id")
		body, _ := json.Marshal(c.Body)
		request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "status", Key: "card"}
		if reply, err := benchworkspace.ParseResponse(body, c.Status, request); err != nil || reply.OK || reply.Error == nil {
			t.Fatal("corpus case is not a status error the parser accepts", name, err)
		}
		return statusFailure{status: c.Status, body: body}
	}
	t.Fatal("corpus case missing", name)
	return statusFailure{}
}

// The status read before every prepare must parse a reclaimed bench, and a
// reclaimed bench is a create for the same key, not an error.
func TestChooseCreatesAgainAfterReclaim(t *testing.T) {
	for _, c := range []struct {
		phase  string
		create bool
	}{{"reclaimed", true}, {"ready", false}} {
		h, producer := reclaimHandler(t, c.phase)
		_, request := prepareFixture(t)
		spec, _, err := h.choose(context.Background(), request, h.registry.Profiles[0])
		if err != nil {
			t.Fatal(c.phase, err)
		}
		if spec.Create != c.create || (spec.CreateRequestID != "") != c.create || producer.count("status") != 1 {
			t.Fatalf("%q: create=%v id=%q", c.phase, spec.Create, spec.CreateRequestID)
		}
		if c.create && spec.CreateRequestID != "create_"+intentName(*request.Identity) {
			t.Fatal("create is not keyed to the attempt")
		}
	}
}

// A reclaiming bench is not ready yet: the prepare stays pending, records no
// choice and creates nothing. Once reclaimed, the retry chooses create once,
// and a further retry reuses that choice without reading status again.
func TestReclaimingBenchParksThePrepare(t *testing.T) {
	h, producer := reclaimHandler(t, "reclaiming")
	raw, request := prepareFixture(t)
	s := intentStore(t)
	choose := func(ctx context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		return h.choose(ctx, request, h.registry.Profiles[0])
	}
	if _, _, err := h.choose(context.Background(), request, h.registry.Profiles[0]); !errors.Is(err, ErrReclaiming) {
		t.Fatal("reclaiming was not parked", err)
	}
	if _, err := s.Resolve(context.Background(), raw, choose); err == nil {
		t.Fatal("a reclaiming bench resolved a choice")
	}
	if got := transportOutcome(request, pending(request), ErrIntent); got.State != "pending" {
		t.Fatal("parked prepare left as", got.State)
	}
	if intent, err := s.Read(context.Background(), request); err != nil || intent.Phase != "reserved" || intent.Spec != nil {
		t.Fatal("reclaiming bench recorded a choice")
	}
	producer.mu.Lock()
	producer.phase = "reclaimed"
	producer.mu.Unlock()
	first, err := s.Resolve(context.Background(), raw, choose)
	if err != nil || first.Spec == nil || !first.Spec.Create {
		t.Fatal("reclaimed bench did not choose create", err)
	}
	again, err := s.Resolve(context.Background(), raw, choose)
	if err != nil || again.Spec.CreateRequestID != first.Spec.CreateRequestID || producer.count("status") != 3 {
		t.Fatal("retry re-chose", producer.count("status"))
	}
	if producer.count("create") != 0 {
		t.Fatal("choose created")
	}
}

// A registered bench stuck before ready is a create with the attempt's own
// request ID, so the registered launch can recover it. The grouped launch
// keeps leasing, unchanged.
func TestChooseCreatesOverAStuckRegisteredBench(t *testing.T) {
	for _, phase := range []string{"materializing", "initializing"} {
		for _, launch := range []string{benchlaunch.Mode, ""} {
			h, producer := reclaimHandler(t, phase)
			h.registry.Profiles[0].Launch = launch
			_, request := prepareFixture(t)
			spec, _, err := h.choose(context.Background(), request, h.registry.Profiles[0])
			if err != nil {
				t.Fatal(phase, launch, err)
			}
			want := launch == benchlaunch.Mode
			if spec.Create != want || (spec.CreateRequestID == "create_"+intentName(*request.Identity)) != want || producer.count("status") != 1 {
				t.Fatalf("%s %q: create=%v id=%q", phase, launch, spec.Create, spec.CreateRequestID)
			}
		}
	}
}

// A card's first attempt: SuperBench has no bench for the key and answers the
// specific-key status with not_found. That is absence, so choose creates the
// bench, keyed to the attempt. Before this, not_found was an internal error
// and the first attempt of every new card stayed pending forever.
func TestChooseCreatesWhenTheKeyIsNotFound(t *testing.T) {
	for _, launch := range []string{benchlaunch.Mode, ""} {
		h, producer := reclaimHandler(t, "absent")
		h.registry.Profiles[0].Launch = launch
		_, request := prepareFixture(t)
		spec, _, err := h.choose(context.Background(), request, h.registry.Profiles[0])
		if err != nil {
			t.Fatalf("%q: not_found was not absence: %v", launch, err)
		}
		if !spec.Create || spec.CreateRequestID != "create_"+intentName(*request.Identity) || producer.count("status") != 1 || producer.count("create") != 0 {
			t.Fatalf("%q: create=%v id=%q", launch, spec.Create, spec.CreateRequestID)
		}
	}
}

// unavailable proves nothing about the key: it must never be read as absence.
// choose records no choice, so the prepare stays pending and is retried.
func TestChooseParksWhenStatusIsUnavailable(t *testing.T) {
	h, producer := reclaimHandler(t, "unavailable")
	raw, request := prepareFixture(t)
	if _, _, err := h.choose(context.Background(), request, h.registry.Profiles[0]); !errors.Is(err, ErrIntent) {
		t.Fatal("unavailable status was not an unknown", err)
	}
	s := intentStore(t)
	choose := func(ctx context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		return h.choose(ctx, request, h.registry.Profiles[0])
	}
	if _, err := s.Resolve(context.Background(), raw, choose); err == nil {
		t.Fatal("an unavailable status resolved a choice")
	}
	if intent, err := s.Read(context.Background(), request); err != nil || intent.Spec != nil {
		t.Fatal("unavailable status recorded a choice")
	}
	if got := transportOutcome(request, pending(request), ErrIntent); got.State != "pending" {
		t.Fatal("unavailable prepare left as", got.State)
	}
	if producer.count("create") != 0 {
		t.Fatal("choose created")
	}
}
