package benchbridge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

// upgradedNode is a node whose registry no longer serves the fixture prepare's target (a node
// build or pin change replaced it), with a hub that answers each current check with `decision`.
func upgradedNode(t *testing.T, decision string) (*Handler, *atomic.Int32) {
	t.Helper()
	path, registry := registryFixture(t)
	_, digest, err := readRegistry(path, registry.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 65537))
		d := decisionFor(t, raw)
		if decision != "current" {
			d.Decision, d.Code = "refused", decision
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(d)
	}))
	t.Cleanup(server.Close)
	current, err := NewHubCurrent(server.URL, registry.NodeID, "synthetic-private")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(current.Close)
	return &Handler{registryPath: path, registry: registry, registrySHA: digest, current: current}, &calls
}

func intentAt(t *testing.T, h *Handler, raw []byte, phase string) {
	t.Helper()
	store := IntentStore{Root: h.registry.IntentRoot}
	_, prepare := prepareFixture(t)
	choose := func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		if phase == "reserved" {
			return benchdispatch.SourceSpec{}, benchdispatch.SourceTask{}, ErrCurrent
		}
		spec, task := intentChoice(prepare)
		return spec, task, nil
	}
	_, _ = store.Resolve(context.Background(), raw, choose)
	if phase == "effects" {
		if send, err := store.ClaimEffects(context.Background(), raw); !send || err != nil {
			t.Fatal("effects not claimed", err)
		}
	}
}

func superseded(t *testing.T, phase, decision string) (benchcoordinatorwire.Response, int32) {
	t.Helper()
	raw, prepare := prepareFixture(t)
	h, calls := upgradedNode(t, decision)
	if phase != "" {
		intentAt(t, h, raw, phase)
	}
	status := statusFor(t, prepare)
	if _, err := h.profile(status); err == nil {
		t.Fatal("fixture: the registry still serves the old target")
	}
	response, err := h.serve(context.Background(), status, nil)
	return transportOutcome(status, response, err), calls.Load()
}

// Upgrade-stranded attempts used to answer refused/unavailable forever, because status required a
// profile matching the old target. Before any effect, and with the hub's stale_owner, the node now
// says stale_owner, which the hub's auto-retire reads as proof that nothing is outstanding.
func TestSupersededTargetBeforeEffectsAnswersStaleOwner(t *testing.T) {
	for _, phase := range []string{"reserved", "resolved"} {
		got, calls := superseded(t, phase, "stale_owner")
		if got.State != "refused" || got.Code != "stale_owner" || calls != 1 {
			t.Fatalf("%s answered %s/%s after %d hub checks", phase, got.State, got.Code, calls)
		}
	}
}

// Both keys must agree: a hub that does not say stale_owner retires nothing.
func TestSupersededTargetNeedsTheHubsStaleDecision(t *testing.T) {
	for _, decision := range []string{"current", "unavailable", "pending"} {
		got, _ := superseded(t, "reserved", decision)
		if got.Code == "stale_owner" {
			t.Fatalf("hub %s let the node retire", decision)
		}
	}
}

// No intent, or effects that no registered journal record accounts for (a grouped launch, or an
// interrupted handoff), proves nothing: refused/unavailable, parked for an owner or admin.
func TestSupersededTargetWithoutProofStaysUnavailable(t *testing.T) {
	for _, phase := range []string{"", "effects"} {
		got, _ := superseded(t, phase, "stale_owner")
		if got.State != "refused" || got.Code != "unavailable" {
			t.Fatalf("intent %q answered %s/%s", phase, got.State, got.Code)
		}
	}
}
