package benchcoordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

func taskForCancellation() benchdispatch.SourceTask {
	return benchdispatch.SourceTask{Arguments: []string{"/bin/sh", "-c", "exit 0"}, Prompt: "private task", Environment: map[string]string{}, TimeoutSeconds: 30}
}
func journalBytes(t *testing.T, c benchdispatch.SourceCoordinator, spec benchdispatch.SourceSpec) []byte {
	t.Helper()
	raw, e := os.ReadFile(filepath.Join(c.Store.Root, hash([]byte(spec.BenchKey))+".json"))
	if e != nil {
		t.Fatal(e)
	}
	return raw
}
func cancellationReply(t *testing.T, w http.ResponseWriter, raw []byte) bool {
	t.Helper()
	target, e := benchworkspace.ParseCancelRequest(raw)
	if e != nil {
		return false
	}
	body, _ := json.Marshal(benchworkspace.CancelResponse{Version: benchworkspace.Version, Operation: "cancel", OK: true, Result: &benchworkspace.CancelObservation{TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: "already_completed"}})
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
	return true
}
func stoppedReply(t *testing.T, w http.ResponseWriter, raw []byte, spec benchdispatch.SourceSpec) bool {
	t.Helper()
	r, e := benchworkspace.Parse(raw)
	if e != nil || r.Operation != "stop" {
		return false
	}
	if r.LeaseToken != hash([]byte("private lease token"))[:48] || r.RequestID != "" || r.Holder != "" {
		t.Error("not original exact-token stop")
	}
	response := benchworkspace.Response{Version: benchworkspace.Version, Operation: "stop", OK: true, Result: &benchworkspace.Mutation{Workspace: benchworkspace.Workspace{Key: spec.BenchKey, BenchID: strings.Repeat("b", 32), Phase: "ready", MemberCount: 1, CheckpointRepository: "a", QuotaBytes: 32 << 20, QuotaInodes: 4096, Lease: &benchworkspace.LeaseSummary{Holder: spec.Holder, Mode: "cooperative", StopRequested: true}, Checkpoint: &benchworkspace.Checkpoint{GenerationID: strings.Repeat("c", 32), ManifestSHA256: strings.Repeat("d", 64), Seal: strings.Repeat("e", 40), Members: []benchworkspace.Commit{{Name: "a", Commit: strings.Repeat("a", 40)}}}}}}
	body, _ := json.Marshal(response)
	if _, e = benchworkspace.ParseResponse(body, 200, r); e != nil {
		t.Error(e)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
	return true
}
func TestCancellationTombstoneVetoesLatePrepareAcrossRestart(t *testing.T) {
	var calls atomic.Int32
	c, spec, _, _ := completionFixtureWith(t, true, func(http.ResponseWriter, []byte) bool { calls.Add(1); return false })
	m := Manager{Source: c}
	status, e := m.Cancel(t.Context(), spec)
	if e != nil || status.State != "cancel_requested" || calls.Load() != 0 {
		t.Fatal("pre-source cancel", status, e)
	}
	before := journalBytes(t, c, spec)
	if !bytes.Contains(before, []byte("agentpod.private-bench-dispatch.v3")) {
		t.Fatal("missing explicit journal version")
	}
	restarted := Manager{Source: c}
	if _, e = restarted.Prepare(t.Context(), spec, taskForCancellation()); !errors.Is(e, benchdispatch.ErrOwner) || calls.Load() != 0 {
		t.Fatal("late Prepare had effects", e)
	}
	if _, e = c.Prepare(t.Context(), spec, taskForCancellation()); !errors.Is(e, benchdispatch.ErrOwner) || calls.Load() != 0 {
		t.Fatal("raw Prepare bypassed intent", e)
	}
	different := spec
	different.HostID = "another-host"
	if e = c.Store.BeginCancellation(t.Context(), different, c.Current); !errors.Is(e, benchdispatch.ErrConflict) {
		t.Fatal("rebound cancellation", e)
	}
	if !bytes.Equal(before, journalBytes(t, c, spec)) {
		t.Fatal("refusal mutated tombstone")
	}
}
func TestPreparedCancellationUsesOnlyOriginalOperationAndPrivateOwner(t *testing.T) {
	var c benchdispatch.SourceCoordinator
	var spec benchdispatch.SourceSpec
	var mu sync.Mutex
	var targets []benchworkspace.CancelRequest
	stops := 0
	hook := func(w http.ResponseWriter, raw []byte) bool {
		if target, e := benchworkspace.ParseCancelRequest(raw); e == nil {
			if _, e = c.Store.CancellationStatus(t.Context(), spec); e != nil {
				t.Error("transport before durable intent", e)
			}
			mu.Lock()
			targets = append(targets, target)
			mu.Unlock()
			return cancellationReply(t, w, raw)
		}
		if r, e := benchworkspace.Parse(raw); e == nil && r.Operation == "stop" {
			mu.Lock()
			stops++
			mu.Unlock()
			return stoppedReply(t, w, raw, spec)
		}
		return false
	}
	var p benchdispatch.Plan
	var runs *atomic.Int32
	c, spec, p, runs = completionFixtureWith(t, false, hook)
	before := journalBytes(t, c, spec)
	m := Manager{Source: c}
	status, e := m.Cancel(t.Context(), spec)
	if e != nil || status.State != "cancel_requested" || !status.RequiresReconciliation || len(status.Observations) != 2 {
		t.Fatal("cancel inferred completion", status, e)
	}
	raw, _ := json.Marshal(status)
	for _, secret := range []string{p.ContextPath, p.Grouped.WorkspaceRoot, hash([]byte("private lease token"))[:48], "/authorized/a"} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatal("private cleanup metadata leaked")
		}
	}
	plan, e := c.Store.CancellationPlan(t.Context(), spec, c.Current)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = json.Marshal(plan); e == nil || strings.Contains(fmt.Sprintf("%#v %#v", plan, *plan), hash([]byte("private lease token"))[:48]) {
		t.Fatal("cleanup plan serializes or formats capability")
	}
	if _, e = m.Execute(t.Context(), spec, func(context.Context, benchdispatch.SourceBinding) error { return nil }); !errors.Is(e, benchdispatch.ErrOwner) || runs.Load() != 0 {
		t.Fatal("cancelled execute launched", e)
	}
	if _, e = m.Cancel(t.Context(), spec); e != nil {
		t.Fatal("exact cleanup retry", e)
	}
	mu.Lock()
	defer mu.Unlock()
	if stops != 2 || len(targets) != 2 || targets[0] != targets[1] || targets[0].TargetRequestID != spec.LeaseRequestID {
		t.Fatal("cleanup changed original target", stops, targets)
	}
	var old, now map[string]json.RawMessage
	if json.Unmarshal(before, &old) != nil || json.Unmarshal(journalBytes(t, c, spec), &now) != nil || !bytes.Equal(old["records"], now["records"]) || !bytes.Equal(old["active"], now["active"]) {
		t.Fatal("v2->v3 rewrote prior source/owner evidence")
	}
}

func TestCancellationDuringLeasePreservesLatePrivateReplyButVetoesCheckpoint(t *testing.T) {
	entered, proceed := make(chan struct{}), make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(proceed) }) })
	var calls atomic.Int32
	var spec benchdispatch.SourceSpec
	hook := func(w http.ResponseWriter, raw []byte) bool {
		if r, e := benchworkspace.Parse(raw); e == nil && r.Operation == "lease" {
			close(entered)
			<-proceed
			return false
		}
		calls.Add(1)
		if cancellationReply(t, w, raw) {
			return true
		}
		return stoppedReply(t, w, raw, spec)
	}
	c, initial, _, runs := completionFixtureWith(t, true, hook)
	spec = initial
	m := Manager{Source: c}
	done := make(chan error, 1)
	go func() { _, e := m.Prepare(t.Context(), spec, taskForCancellation()); done <- e }()
	<-entered
	status, e := m.Cancel(t.Context(), spec)
	if e != nil || len(status.Observations) != 1 || status.Observations[0].State != "already_completed" {
		t.Fatal("pending lease cancellation", status, e)
	}
	release.Do(func() { close(proceed) })
	if e = <-done; !errors.Is(e, benchdispatch.ErrOwner) {
		t.Fatal("late lease proceeded to checkpoint/bind", e)
	}
	before := journalBytes(t, c, spec)
	if !bytes.Contains(before, []byte(`"phase":"observed"`)) || !bytes.Contains(before, []byte(`"step":"lease"`)) {
		t.Fatal("late original receipt discarded")
	}
	if _, e = m.Cancel(t.Context(), spec); e != nil {
		t.Fatal("late owner cleanup", e)
	}
	if calls.Load() != 3 || runs.Load() != 0 {
		t.Fatal("unexpected effects after intent", calls.Load(), runs.Load())
	}
	if _, e = m.Prepare(t.Context(), spec, taskForCancellation()); !errors.Is(e, benchdispatch.ErrOwner) {
		t.Fatal("restarted prepare revived cancelled owner", e)
	}
}

func TestMalformedCancelReplyKeepsIntentAndNeverFallsBackToOwnerStop(t *testing.T) {
	var cleanup atomic.Int32
	c, spec, _, runs := completionFixtureWith(t, false, func(w http.ResponseWriter, raw []byte) bool {
		if _, e := benchworkspace.ParseCancelRequest(raw); e == nil {
			cleanup.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"superbench.v2","operation":"cancel","ok":true,"result":{}}`))
			return true
		}
		if r, e := benchworkspace.Parse(raw); e == nil && r.Operation == "stop" {
			t.Error("uncertain cancellation fell through to stop")
		}
		return false
	})
	m := Manager{Source: c}
	status, e := m.Cancel(t.Context(), spec)
	if !errors.Is(e, benchdispatch.ErrPending) || !status.RequiresReconciliation || cleanup.Load() != 1 {
		t.Fatal("malformed ACK accepted", status, e)
	}
	status, e = m.Status(t.Context(), spec)
	if e != nil || len(status.Observations) != 1 || status.Observations[0].State != "uncertain" {
		t.Fatal("uncertainty not preserved", status, e)
	}
	if _, e = m.Execute(t.Context(), spec, func(context.Context, benchdispatch.SourceBinding) error { return nil }); !errors.Is(e, benchdispatch.ErrOwner) || runs.Load() != 0 {
		t.Fatal("uncertain cancellation allowed dispatch", e)
	}
}

func TestCancellationJournalRejectsFutureAndCorruptStateWithoutEffects(t *testing.T) {
	for _, corrupt := range []func(map[string]any){
		func(doc map[string]any) { doc["version"] = "agentpod.private-bench-dispatch.v4" },
		func(doc map[string]any) { doc["version"] = "agentpod.private-bench-dispatch.v2" },
		func(doc map[string]any) { delete(doc, "cancellations") },
		func(doc map[string]any) { doc["cancellations"] = []any{} },
		func(doc map[string]any) { doc["cancellations"] = nil },
		func(doc map[string]any) {
			doc["version"] = "agentpod.private-bench-dispatch.v2"
			doc["cancellations"] = nil
		},
		func(doc map[string]any) {
			doc["cancellations"] = []any{map[string]any{"identity_sha256": strings.Repeat("a", 64), "source_sha256": "changed"}}
		},
	} {
		var calls atomic.Int32
		c, spec, _, _ := completionFixtureWith(t, true, func(http.ResponseWriter, []byte) bool { calls.Add(1); return false })
		m := Manager{Source: c}
		if _, e := m.Cancel(t.Context(), spec); e != nil {
			t.Fatal(e)
		}
		var doc map[string]any
		if e := json.Unmarshal(journalBytes(t, c, spec), &doc); e != nil {
			t.Fatal(e)
		}
		corrupt(doc)
		raw, e := json.Marshal(doc)
		if e != nil {
			t.Fatal(e)
		}
		path := filepath.Join(c.Store.Root, hash([]byte(spec.BenchKey))+".json")
		if e = os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
		if _, e = m.Cancel(t.Context(), spec); !errors.Is(e, benchdispatch.ErrInvalid) {
			t.Fatal("corrupt cancellation interpreted", e)
		}
		if _, e = m.Prepare(t.Context(), spec, taskForCancellation()); !errors.Is(e, benchdispatch.ErrInvalid) {
			t.Fatal("corrupt cancellation allowed preparation", e)
		}
		if calls.Load() != 0 || !bytes.Equal(raw, journalBytes(t, c, spec)) {
			t.Fatal("refusal changed evidence or sent transport")
		}
	}
}
