package benchbridge

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

// statusFor is the hub's status request for the prepare's exact retained identity and target.
func statusFor(t *testing.T, prepare benchcoordinatorwire.Request) benchcoordinatorwire.Request {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"version": benchcoordinatorwire.Version, "operation": "status",
		"identity": prepare.Identity, "target": prepare.Target})
	r, err := benchcoordinatorwire.ParseRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// reservedIntent leaves the intent as a prepare whose in-Resolve current check failed: reserved, no Spec.
func reservedIntent(t *testing.T, store IntentStore, raw []byte) {
	t.Helper()
	_, err := store.Resolve(context.Background(), raw, func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		return benchdispatch.SourceSpec{}, benchdispatch.SourceTask{}, ErrCurrent
	})
	if !errors.Is(err, ErrIntent) {
		t.Fatal("the failed choice did not park the prepare", err)
	}
}

// The staging strand: the hub's current reply outran the node's header timeout inside Resolve, so
// the intent stayed reserved with no Spec, and every later status answered pending forever. Status
// now says unknown, the one reply that lets the hub re-send the identical prepare.
func TestStatusOfAReservedIntentIsUnknown(t *testing.T) {
	raw, prepare := prepareFixture(t)
	store := intentStore(t)
	reservedIntent(t, store, raw)
	status := statusFor(t, prepare)
	intent, err := store.Read(context.Background(), status)
	if err != nil || intent.Phase != "reserved" || intent.Spec != nil {
		t.Fatal("fixture is not a reserved intent", intent.Phase, err)
	}
	response, err := (&Handler{}).status(context.Background(), status, LocalProfile{}, intent)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(transportOutcome(status, response, err))
	if _, err = benchcoordinatorwire.ParseResponse(got, status); err != nil || response.State != "unknown" {
		t.Fatalf("a reserved intent answered %s", got)
	}
}

// Only reserved proves nothing was chosen. A resolved intent always carries its Spec; a
// hand-damaged one without it never says unknown, so the hub never re-sends over an effect.
func TestOnlyAReservedIntentIsUnknown(t *testing.T) {
	_, prepare := prepareFixture(t)
	status := statusFor(t, prepare)
	for _, phase := range []string{"resolved", "effects"} {
		response, err := (&Handler{}).status(context.Background(), status, LocalProfile{}, Intent{Phase: phase})
		if response.State == "unknown" || err == nil {
			t.Fatalf("%s without a spec answered %s", phase, response.State)
		}
	}
}

// Re-sending the identical prepare finishes the choice exactly once; any other bytes for the same
// attempt are refused, so the recovery can never redefine what the attempt is.
func TestIdenticalPrepareFinishesAReservedIntentOnce(t *testing.T) {
	raw, prepare := prepareFixture(t)
	store := intentStore(t)
	reservedIntent(t, store, raw)
	changed := append([]byte(nil), raw...)
	changed = append(changed, ' ')
	calls := 0
	choose := func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error) {
		calls++
		spec, task := intentChoice(prepare)
		return spec, task, nil
	}
	if _, err := store.Resolve(context.Background(), changed, choose); !errors.Is(err, ErrIntent) || calls != 0 {
		t.Fatal("different prepare bytes reached the chooser")
	}
	for i := 0; i < 2; i++ {
		intent, err := store.Resolve(context.Background(), raw, choose)
		if err != nil || intent.Phase != "resolved" || intent.Spec == nil {
			t.Fatal("identical prepare did not resolve", err)
		}
	}
	if calls != 1 {
		t.Fatalf("chooser ran %d times", calls)
	}
	if send, err := store.ClaimEffects(context.Background(), raw); !send || err != nil {
		t.Fatal("first effects claim refused", err)
	}
	if send, err := store.ClaimEffects(context.Background(), raw); send || err != nil {
		t.Fatal("effects claimed twice", err)
	}
}
