package benchbridge

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// benchProducer keeps one card's bench and answers status and reclaim as SuperBench does: a reclaim
// of a ready bench with no lease deletes it, so a later status shows it reclaimed.
type benchProducer struct {
	mu    sync.Mutex
	phase string
	lease bool
	ops   map[string]int
}

func (p *benchProducer) count(op string) int { p.mu.Lock(); defer p.mu.Unlock(); return p.ops[op] }

func (p *benchProducer) workspace(key string) map[string]any {
	seal := strings.Repeat("a", 40)
	w := map[string]any{"key": key, "bench_id": strings.Repeat("1", 32), "phase": p.phase, "member_count": 1,
		"checkpoint_repository": "api", "ready_for_acquisition": p.phase == "ready" && !p.lease, "quota_bytes": 1 << 30, "quota_inodes": 1 << 20,
		"checkpoint": map[string]any{"generation_id": strings.Repeat("2", 32), "seal": seal, "manifest_sha256": strings.Repeat("c", 64),
			"members": []any{map[string]string{"name": "api", "commit": seal}}}}
	if p.lease {
		w["lease"] = map[string]any{"holder": "cp_attempt", "mode": "cooperative", "stop_requested": false}
	}
	return w
}

func settledHandler(t *testing.T, phase string, lease bool, launch string) (*Handler, *benchProducer, ReclaimRequest) {
	t.Helper()
	_, registry := registryFixture(t)
	registry.Profiles[0].Launch = launch
	_, prepareRequest := prepareFixture(t)
	registry.WorkerSHA256 = prepareRequest.Target.WorkerSHA256
	dir, err := os.MkdirTemp("", "bbs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "s")
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	producer := &benchProducer{phase: phase, lease: lease, ops: map[string]int{}}
	server := &http.Server{ReadHeaderTimeout: time.Minute, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request benchworkspace.Request
		_ = json.NewDecoder(r.Body).Decode(&request)
		producer.mu.Lock()
		defer producer.mu.Unlock()
		producer.ops[request.Operation]++
		w.Header().Set("Content-Type", "application/json")
		var body map[string]any
		switch request.Operation {
		case "status":
			bench := producer.workspace(request.Key)
			bench["kind"] = "workspace"
			bench["members"] = []any{map[string]string{"name": "api", "branch": "card/x", "base": "main", "object_format": "sha1", "source_commit": strings.Repeat("a", 40)}}
			body = map[string]any{"version": benchworkspace.Version, "operation": "status", "ok": true, "result": map[string]any{"benches": []any{bench}}}
		case "reclaim":
			if producer.lease || producer.phase != "ready" {
				t.Error("reclaim sent for a bench SuperBench would refuse")
			}
			producer.phase = "reclaimed"
			body = map[string]any{"version": benchworkspace.Version, "operation": "reclaim", "ok": true,
				"result": map[string]any{"workspace": producer.workspace(request.Key)}}
		default:
			t.Error("reclaim sent", request.Operation)
			w.WriteHeader(500)
			return
		}
		raw, _ := json.Marshal(body)
		_, _ = w.Write(raw)
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client, err := benchworkspace.NewClient(socket, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	_, prepare := prepareFixture(t)
	id := prepare.Identity
	return &Handler{registry: registry, client: client}, producer,
		ReclaimRequest{TenantID: id.TenantID, BoardID: id.BoardID, StationID: id.StationID, CardID: id.CardID}
}

// A settled card's bench is reclaimed, and the card coming back (a review bounce) is a fresh create
// for the same key, prepared from its card branch.
func TestASettledCardsBenchIsReclaimedAndABounceCreatesAgain(t *testing.T) {
	h, producer, req := settledHandler(t, "ready", false, benchlaunch.Mode)
	reply, err := h.reclaim(context.Background(), req)
	if err != nil || reply.State != "reclaimed" || producer.count("reclaim") != 1 {
		t.Fatalf("not reclaimed: %+v %v (reclaims %d)", reply, err, producer.count("reclaim"))
	}
	_, prepare := prepareFixture(t)
	spec, _, err := h.choose(context.Background(), prepare, h.registry.Profiles[0])
	if err != nil || !spec.Create || spec.CreateRequestID != "create_"+intentName(*prepare.Identity) {
		t.Fatalf("a bounced card did not get a fresh bench: create=%v id=%q err=%v", spec.Create, spec.CreateRequestID, err)
	}
	// Asked again, there is nothing left to reclaim.
	if reply, _ = h.reclaim(context.Background(), req); reply.State != "absent" || producer.count("reclaim") != 1 {
		t.Fatalf("a reclaimed bench was reclaimed again: %+v", reply)
	}
}

func TestABenchWithAHeldLeaseOrNotReadyIsLeftAlone(t *testing.T) {
	for _, c := range []struct {
		phase string
		lease bool
		code  string
	}{{"ready", true, "lease_held"}, {"reclaiming", false, "not_ready"}} {
		h, producer, req := settledHandler(t, c.phase, c.lease, benchlaunch.Mode)
		reply, err := h.reclaim(context.Background(), req)
		if err != nil || reply.State != "refused" || reply.Code != c.code || producer.count("reclaim") != 0 {
			t.Fatalf("%s: %+v %v (reclaims %d)", c.code, reply, err, producer.count("reclaim"))
		}
	}
}

// An attempt the journal still holds (one owns the bench, or a record is not terminal) keeps the
// bench: nothing is even read from SuperBench.
func TestABenchWithAnUnsettledAttemptIsLeftAlone(t *testing.T) {
	h, producer, req := settledHandler(t, "ready", false, benchlaunch.Mode)
	stable, _ := json.Marshal([]string{req.TenantID, req.BoardID, req.CardID})
	key := "cp_" + rawSHA(stable)
	root := filepath.Join(h.registry.StateRoot, "registered")
	if os.Mkdir(root, 0700) != nil {
		t.Fatal("journal root")
	}
	doc, _ := json.Marshal(map[string]any{"version": "agentpod.registered-launch.v1", "bench_key": key, "active": "attempt-owner", "records": []any{}})
	if os.WriteFile(filepath.Join(root, key+".json"), doc, 0600) != nil {
		t.Fatal("journal")
	}
	reply, err := h.reclaim(context.Background(), req)
	if err != nil || reply.State != "refused" || reply.Code != "unsettled" || producer.count("status") != 0 || producer.count("reclaim") != 0 {
		t.Fatalf("an unsettled bench was touched: %+v %v", reply, err)
	}
}

func TestOnlyTheRegisteredLaunchReclaims(t *testing.T) {
	h, producer, req := settledHandler(t, "ready", false, "")
	reply, err := h.reclaim(context.Background(), req)
	if err != nil || reply.State != "refused" || reply.Code != "unsupported" || producer.count("status") != 0 {
		t.Fatalf("a grouped launch was reclaimed: %+v %v", reply, err)
	}
	if _, err = h.reclaim(context.Background(), ReclaimRequest{TenantID: req.TenantID, BoardID: req.BoardID, StationID: req.StationID, CardID: "x"}); err == nil {
		t.Fatal("a malformed card id was accepted")
	}
}
