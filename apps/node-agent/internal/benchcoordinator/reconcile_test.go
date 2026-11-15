package benchcoordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

func TestCancellationReconcilesLostLeaseOnlyThroughReadLookupAndOriginalTokenStop(t *testing.T) {
	for _, mode := range []string{"completed", "replaced-db-absent", "wrong-original-body", "invalid-ack"} {
		t.Run(mode, func(t *testing.T) {
			var spec benchdispatch.SourceSpec
			var leases, lookups, stops atomic.Int32
			hook := func(w http.ResponseWriter, raw []byte) bool {
				if cancellationReplyTarget, e := benchworkspace.ParseCancelRequest(raw); e == nil {
					if mode == "invalid-ack" {
						w.Header().Set("Content-Type", "application/json")
						_, _ = w.Write([]byte(`{"invalid":"ack"}`))
						return true
					}
					if cancellationReplyTarget.TargetRequestID != spec.LeaseRequestID {
						t.Error("changed cleanup target")
					}
					return cancellationReply(t, w, raw)
				}
				if target, e := benchworkspace.ParseReceiptLookupRequest(raw); e == nil {
					lookups.Add(1)
					if target.TargetRequestID != spec.LeaseRequestID {
						t.Error("lookup target changed")
					}
					result := &benchworkspace.ReceiptLookupResult{TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: "absent"}
					if mode != "replaced-db-absent" {
						original := benchworkspace.Response{Version: benchworkspace.Version, Operation: "lease", OK: true, RequestID: spec.LeaseRequestID, Result: &benchworkspace.Mutation{RootPath: filepath.Join(spec.DataRoot, "benches", spec.BenchKey), Grant: &benchworkspace.Grant{LeaseToken: hash([]byte("private lease token"))[:48]}, Workspace: benchworkspace.Workspace{Key: spec.BenchKey, BenchID: strings.Repeat("b", 32), Phase: "ready", MemberCount: 1, CheckpointRepository: "a", QuotaBytes: 32 << 20, QuotaInodes: 4096, Lease: &benchworkspace.LeaseSummary{Holder: spec.Holder, Mode: "cooperative"}, Checkpoint: &benchworkspace.Checkpoint{GenerationID: strings.Repeat("c", 32), ManifestSHA256: strings.Repeat("d", 64), Seal: strings.Repeat("e", 40), Members: []benchworkspace.Commit{{Name: "a", Commit: strings.Repeat("a", 40)}}}}}}
						if mode == "wrong-original-body" {
							original.RequestID = "foreign-original"
						}
						body, _ := json.Marshal(original)
						result.State = "completed"
						result.HTTPStatus = 200
						result.ResponseBody = string(body)
					}
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(benchworkspace.ReceiptLookupResponse{Version: benchworkspace.Version, Operation: "receipt_lookup", OK: true, Result: result})
					return true
				}
				r, e := benchworkspace.Parse(raw)
				if e != nil {
					return false
				}
				if r.Operation == "lease" {
					leases.Add(1)
					conn, _, e := w.(http.Hijacker).Hijack()
					if e != nil {
						t.Error(e)
					} else {
						_ = conn.Close()
					}
					return true
				}
				if r.Operation == "stop" {
					stops.Add(1)
					return stoppedReply(t, w, raw, spec)
				}
				t.Error("unexpected growth or payload operation", r.Operation)
				return true
			}
			c, initial, _, runs := completionFixtureWith(t, true, hook)
			spec = initial
			m := Manager{Source: c}
			if _, e := m.Prepare(t.Context(), spec, taskForCancellation()); e == nil {
				t.Fatal("lost lease reply accepted")
			}
			before := journalBytes(t, c, spec)
			_, cancelErr := m.Cancel(t.Context(), spec)
			if mode == "invalid-ack" && cancelErr == nil {
				t.Fatal("invalid ACK accepted")
			}
			if mode != "invalid-ack" && cancelErr != nil {
				t.Fatal(cancelErr)
			}
			// Reconstruct the manager to prove no in-memory response or token is used.
			restarted := Manager{Source: c}
			status, e := restarted.ReconcileCancellation(t.Context(), spec)
			if mode == "wrong-original-body" && e == nil {
				t.Fatal("wrong historical request granted cleanup")
			}
			if mode != "wrong-original-body" && (e != nil || !status.RequiresReconciliation) {
				t.Fatal("reconciliation inferred readiness", status, e)
			}
			wantStops := int32(0)
			if mode == "completed" {
				wantStops = 1
			}
			wantLookups := int32(1)
			if mode == "invalid-ack" {
				wantLookups = 0
			}
			if leases.Load() != 1 || lookups.Load() != wantLookups || stops.Load() != wantStops || runs.Load() != 0 {
				t.Fatal("reconciliation redispatched or stopped wrong owner", leases.Load(), lookups.Load(), stops.Load())
			}
			var old, now map[string]json.RawMessage
			if json.Unmarshal(before, &old) != nil || json.Unmarshal(journalBytes(t, c, spec), &now) != nil || !bytes.Equal(old["source"], now["source"]) {
				t.Fatal("historical lookup rewrote original unknown source evidence")
			}
			if _, e = m.Execute(t.Context(), spec, func(context.Context, benchdispatch.SourceBinding) error { return nil }); !errors.Is(e, benchdispatch.ErrOwner) {
				t.Fatal("reconciliation cleared permanent execution veto", e)
			}
		})
	}
}

func TestLegacyV3CancellationPreservesVetoButRejectsFutureExchangeFields(t *testing.T) {
	c, spec, _, _ := completionFixtureWith(t, true, nil)
	m := Manager{Source: c}
	if _, e := m.Cancel(t.Context(), spec); e != nil {
		t.Fatal(e)
	}
	raw := bytes.Replace(journalBytes(t, c, spec), []byte("agentpod.private-bench-dispatch.v4"), []byte("agentpod.private-bench-dispatch.v3"), 1)
	path := filepath.Join(c.Store.Root, hash([]byte(spec.BenchKey))+".json")
	if e := os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := m.Status(t.Context(), spec); e != nil {
		t.Fatal("historical v3 veto unreadable", e)
	}
	if !bytes.Equal(raw, journalBytes(t, c, spec)) {
		t.Fatal("read migrated historical document")
	}
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["cancellations"].([]any)[0].(map[string]any)["exchanges"] = []any{}
	future, _ := json.Marshal(doc)
	if e := os.WriteFile(path, future, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := m.Status(t.Context(), spec); !errors.Is(e, benchdispatch.ErrInvalid) {
		t.Fatal("future fields accepted under v3", e)
	}
}
