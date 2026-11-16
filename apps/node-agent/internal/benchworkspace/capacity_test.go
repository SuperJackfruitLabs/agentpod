package benchworkspace

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestCapacityDiagnosticIsStrictAndNeverRedispatches(t *testing.T) {
	initialize := true
	request := Request{Version: Version, Operation: "create", Key: "card", RequestID: "capacity-create", Initialize: &initialize, CheckpointRepository: "a", Repositories: []Repository{{Name: "a", Repository: "/fixture/a.git"}}}
	const message = "logical reservation capacity exhausted; needed_bytes=6500 available_bytes=6000 needed_inodes=400 available_inodes=900"
	for _, tc := range []struct {
		name, code string
		status     int
		known      bool
	}{
		{"known refusal", "capacity_exhausted", 422, true},
		{"unknown code", "capacity_arbitrary", 422, false},
		{"wrong status", "capacity_exhausted", 503, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"version": Version, "operation": request.Operation, "request_id": request.RequestID, "ok": false, "error": map[string]string{"code": tc.code, "message": message}})
			})
			client, err := NewClient(path, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			out, evidence, err := client.DoWithEvidence(context.Background(), request)
			var failure *Failure
			if !errors.As(err, &failure) || calls.Load() != 1 || evidence == nil {
				t.Fatal("failed mutation lost evidence or redispatched", err, calls.Load())
			}
			if !tc.known {
				if out != nil || failure.Code != "invalid_response" || !failure.Uncertain {
					t.Fatal("unrecognized response became known refusal", out, failure.Code, failure.Uncertain)
				}
				return
			}
			if out == nil || out.OK || out.Error == nil || out.Error.Message != message || failure.Code != "capacity_exhausted" || failure.Uncertain {
				t.Fatalf("known capacity refusal lost: response=%v code=%s uncertain=%v", out, failure.Code, failure.Uncertain)
			}
		})
	}
}

func TestCapacityDiagnosticDoesNotWidenCancellationContract(t *testing.T) {
	initialize := true
	source := Request{Version: Version, Operation: "create", Key: "card", RequestID: "capacity-create", Initialize: &initialize, CheckpointRepository: "a", Repositories: []Repository{{Name: "a", Repository: "/fixture/a.git"}}}
	target, err := NewCancelRequest(source)
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"version":"superbench.v2","operation":"cancel","ok":false,"error":{"code":"capacity_exhausted","message":"logical reservation capacity exhausted"}}`)
	if _, err := ParseCancelResponse(raw, 422, target); !errors.Is(err, ErrResponse) {
		t.Fatal("ordinary diagnostic widened cancellation contract", err)
	}
}
