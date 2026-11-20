package benchbridge

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
)

// A registered-launch record the journal holds as terminal answers status
// with its own code. After a worker crash (benchlaunch
// TestWorkerCrashIsRefusedAndReleased) that is verification_failed, and these
// are the exact bytes the hub's orchestrator is tested to end the attempt on
// (packages/contract bench-coordinator-node-refusals-v1.json).
func TestTerminalRefusalReachesTheWireAsTheRecordedReply(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-node-refusals-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Replies []struct {
			Name    string          `json:"name"`
			Request json.RawMessage `json:"request"`
			Value   json.RawMessage `json:"value"`
		} `json:"replies"`
	}
	if err = json.Unmarshal(raw, &corpus); err != nil || len(corpus.Replies) == 0 {
		t.Fatal("recorded node refusals missing", err)
	}
	for _, c := range corpus.Replies {
		request, err := benchcoordinatorwire.ParseRequest(c.Request)
		if err != nil {
			t.Fatal(c.Name, err)
		}
		var want struct {
			Code string `json:"code"`
		}
		if err = json.Unmarshal(c.Value, &want); err != nil || want.Code == "" {
			t.Fatal(c.Name, "has no code", err)
		}
		response, err := failed(request, &benchlaunch.Refusal{Code: want.Code})
		got, _ := json.Marshal(transportOutcome(request, response, err))
		if _, err = benchcoordinatorwire.ParseResponse(got, request); err != nil {
			t.Fatal(c.Name, "left the bridge as an invalid wire response", err)
		}
		var a, b any
		_ = json.Unmarshal(got, &a)
		_ = json.Unmarshal(c.Value, &b)
		ga, _ := json.Marshal(a)
		gb, _ := json.Marshal(b)
		if string(ga) != string(gb) {
			t.Fatalf("%s left the bridge as\n%s\nnot the recorded\n%s", c.Name, ga, gb)
		}
	}
}

// A completed reply the hub cannot settle (completed-unchanged: a clean run
// with no new commit) is still a valid wire reply from this node: the hub's
// test ends the attempt failed on exactly these bytes, so they must be bytes
// this bridge could send.
func TestRecordedCompletedRepliesAreValidWireReplies(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-node-completions-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Replies []struct {
			Name    string          `json:"name"`
			Request json.RawMessage `json:"request"`
			Value   json.RawMessage `json:"value"`
		} `json:"replies"`
	}
	if err = json.Unmarshal(raw, &corpus); err != nil || len(corpus.Replies) == 0 {
		t.Fatal("recorded node completions missing", err)
	}
	for _, c := range corpus.Replies {
		request, err := benchcoordinatorwire.ParseRequest(c.Request)
		if err != nil {
			t.Fatal(c.Name, err)
		}
		response, err := benchcoordinatorwire.ParseResponse(c.Value, request)
		if err != nil || response.State != "completed" || response.Completion == nil {
			t.Fatal(c.Name, "is not a completed wire reply", err)
		}
	}
}
