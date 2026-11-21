package benchbridge

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

// Every node-internal parked state, including the registered launch's
// release_refused, leaves the bridge as exactly the shared corpus's "pending"
// response: the bytes the hub's TypeScript parser is tested to accept
// (packages/contract bench-coordinator.test.ts) and the orchestrator parks.
func TestInternalParkedStatesReachTheWireAsPending(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Responses []struct {
			Name    string          `json:"name"`
			Request json.RawMessage `json:"request"`
			Value   json.RawMessage `json:"value"`
			Accept  bool            `json:"accept"`
		} `json:"responses"`
	}
	if err = json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	var want, sent json.RawMessage
	for _, c := range corpus.Responses {
		if c.Name == "pending" && c.Accept {
			want, sent = c.Value, c.Request
		}
	}
	request, err := benchcoordinatorwire.ParseRequest(sent)
	if want == nil || err != nil {
		t.Fatal("shared pending fixture missing", err)
	}
	for _, state := range []string{"cancel_requested", "release_refused", "pending", "a-future-internal-state"} {
		response, err := statusResponse(request, benchdispatch.SourceSpec{}, benchcoordinator.Status{State: state, RequiresReconciliation: true})
		if err != nil {
			t.Fatal(state, err)
		}
		got, _ := json.Marshal(transportOutcome(request, response, err))
		if _, err = benchcoordinatorwire.ParseResponse(got, request); err != nil {
			t.Fatal(state, "left the bridge as an invalid wire response", err)
		}
		var a, b bytes.Buffer
		_ = json.Compact(&a, got)
		_ = json.Compact(&b, want)
		var x, y any
		_ = json.Unmarshal(a.Bytes(), &x)
		_ = json.Unmarshal(b.Bytes(), &y)
		ga, _ := json.Marshal(x)
		gb, _ := json.Marshal(y)
		if !bytes.Equal(ga, gb) {
			t.Fatalf("%s did not reach the wire as the shared pending response:\n%s", state, got)
		}
	}
}

// A parked attempt whose lease is still held after a refused release leaves
// the bridge as the shared corpus's pending-with-lease-held bytes.
func TestAHeldLeaseReachesTheWireAsParkedDetail(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Responses []struct {
			Name    string          `json:"name"`
			Request json.RawMessage `json:"request"`
			Value   json.RawMessage `json:"value"`
		} `json:"responses"`
	}
	if err = json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, c := range corpus.Responses {
		if c.Name != "pending-with-lease-held" {
			continue
		}
		request, err := benchcoordinatorwire.ParseRequest(c.Request)
		if err != nil {
			t.Fatal(err)
		}
		response, err := statusResponse(request, benchdispatch.SourceSpec{}, benchcoordinator.Status{State: "release_refused", RequiresReconciliation: true, LeaseHeld: true})
		if err != nil {
			t.Fatal(err)
		}
		got, _ := json.Marshal(transportOutcome(request, response, err))
		var x, y any
		_ = json.Unmarshal(got, &x)
		_ = json.Unmarshal(c.Value, &y)
		ga, _ := json.Marshal(x)
		gb, _ := json.Marshal(y)
		if string(ga) != string(gb) {
			t.Fatalf("a held lease left the bridge as\n%s\nnot\n%s", ga, gb)
		}
		return
	}
	t.Fatal("shared pending-with-lease-held fixture missing")
}
