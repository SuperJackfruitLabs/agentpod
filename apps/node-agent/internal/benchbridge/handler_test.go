package benchbridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestChooseRejectsUnrepresentableTimeoutBeforeReadingSource(t *testing.T) {
	_, request := prepareFixture(t)
	for _, timeout := range []uint64{0, 3601, 1<<32 + 1, ^uint64(0)} {
		request.Task.TimeoutSeconds = timeout
		// A nil client makes any accidental source inventory read fail this test.
		_, _, err := (&Handler{}).choose(context.Background(), request, LocalProfile{})
		if !errors.Is(err, ErrIntent) {
			t.Fatalf("invalid timeout %d reached source", timeout)
		}
	}
}

func TestTransportOutcomeRetainsPendingWithoutDisclosingInternalErrors(t *testing.T) {
	_, request := prepareFixture(t)
	private := errors.New("/private/retained-plan fixture-lease-capability")
	for _, state := range []string{"pending", "refused", "completed"} {
		response := pending(request)
		response.State = state
		got := transportOutcome(request, response, private)
		expected := "refused"
		if state == "pending" {
			expected = "pending"
		}
		if got.State != expected {
			t.Fatalf("%s became %s", state, got.State)
		}
		raw, err := json.Marshal(got)
		if err != nil || strings.Contains(string(raw), private.Error()) || strings.Contains(string(raw), "capability") {
			t.Fatal("internal evidence escaped outcome mapping")
		}
	}
	good := pending(request)
	if got := transportOutcome(request, good, nil); got.State != good.State {
		t.Fatal("successful pending projection changed")
	}
}
