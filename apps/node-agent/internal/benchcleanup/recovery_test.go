package benchcleanup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

func captured(t *testing.T, target benchworkspace.CancelRequest, lookup bool, body []byte) *benchworkspace.ExchangeEvidence {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "bc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "s")
	l, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", path)
	if err != nil {
		t.Fatal(err)
	}
	s := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "/v2/operations"
		if lookup {
			want = "/v2/receipts/lookup"
		}
		if r.URL.Path != want {
			t.Error("original operation body dispatched")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})}
	go func() { _ = s.Serve(l) }()
	t.Cleanup(func() { _ = s.Close() })
	c, err := benchworkspace.NewClient(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var e *benchworkspace.ExchangeEvidence
	if lookup {
		_, e, _ = c.LookupReceiptWithEvidence(context.Background(), benchworkspace.ReceiptLookupRequest{Version: target.Version, Operation: "receipt_lookup", TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest})
	} else {
		_, e, _ = c.CancelWithEvidence(context.Background(), target)
	}
	if e == nil {
		t.Fatal("actual private exchange not captured")
	}
	return e
}

func TestFullCleanupEvidenceCapacityPreservesExactReplayWithoutNewFiles(t *testing.T) {
	_, target, _ := recoveryFixture(t)
	root := t.TempDir()
	_ = os.Chmod(root, 0700)
	p, err := New([]benchworkspace.CancelRequest{target}, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &benchattempt.Cancellation{}
	var last *benchworkspace.ExchangeEvidence
	for n := 0; n < 32; n++ {
		last = captured(t, target, false, []byte(fmt.Sprintf(`{"unknown_attempt":%d}`, n)))
		if changed, err := ObserveExchange(root, c, p, p, last); err != nil || !changed {
			t.Fatal("bounded evidence insert", n, err)
		}
	}
	before, _ := os.ReadDir(root)
	if changed, err := ObserveExchange(root, c, p, p, last); err != nil || changed {
		t.Fatal("full-cap exact replay lost idempotence", err)
	}
	unique := captured(t, target, false, []byte(`{"unknown_attempt":33}`))
	if _, err := ObserveExchange(root, c, p, p, unique); !errors.Is(err, benchattempt.ErrInvalid) {
		t.Fatal("new evidence exceeded cap", err)
	}
	after, _ := os.ReadDir(root)
	if len(before) != len(after) || len(c.Exchanges) != 32 {
		t.Fatal("capacity refusal wrote files or evidence")
	}
}
func recoveryFixture(t *testing.T) (benchworkspace.Request, benchworkspace.CancelRequest, []byte) {
	t.Helper()
	raw, err := os.ReadFile("../benchworkspace/testdata/receipt-lookup/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Valid []struct {
			Original *benchworkspace.Request `json:"original_request"`
			Body     json.RawMessage
		}
	}
	if json.Unmarshal(raw, &corpus) != nil {
		t.Fatal("owner fixture")
	}
	for _, c := range corpus.Valid {
		if c.Original != nil {
			target, err := benchworkspace.NewCancelRequest(*c.Original)
			if err != nil {
				t.Fatal(err)
			}
			return *c.Original, target, c.Body
		}
	}
	t.Fatal("missing real historical response")
	return benchworkspace.Request{}, benchworkspace.CancelRequest{}, nil
}
func TestVerifiedACKAllowsReadOnlyLookupButAbsenceNeverRecoversGrant(t *testing.T) {
	original, target, complete := recoveryFixture(t)
	root := t.TempDir()
	_ = os.Chmod(root, 0700)
	p, err := New([]benchworkspace.CancelRequest{target}, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &benchattempt.Cancellation{}
	lookup := captured(t, target, true, complete)
	if _, err = ObserveExchange(root, c, p, p, lookup); !errors.Is(err, benchattempt.ErrPending) {
		t.Fatal("lookup accepted without ACK", err)
	}
	files, _ := os.ReadDir(root)
	if len(files) != 0 {
		t.Fatal("unauthorized lookup persisted")
	}
	bad := captured(t, target, false, []byte(`{"invalid":"not-an-ack"}`))
	if _, err = ObserveExchange(root, c, p, p, bad); err != nil {
		t.Fatal(err)
	}
	if targets, err := LookupTargets(root, c, p); err != nil || len(targets) != 0 {
		t.Fatal("malformed ACK allowed lookup", err)
	}
	ack, _ := json.Marshal(benchworkspace.CancelResponse{Version: target.Version, Operation: "cancel", OK: true, Result: &benchworkspace.CancelObservation{TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: "already_completed"}})
	if _, err = ObserveExchange(root, c, p, p, captured(t, target, false, ack)); err != nil {
		t.Fatal(err)
	}
	if targets, err := LookupTargets(root, c, p); err != nil || len(targets) != 1 {
		t.Fatal("verified exact ACK missing", err)
	}
	absent, _ := json.Marshal(benchworkspace.ReceiptLookupResponse{Version: target.Version, Operation: "receipt_lookup", OK: true, Result: &benchworkspace.ReceiptLookupResult{TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: "absent"}})
	if _, err = ObserveExchange(root, c, p, p, captured(t, target, true, absent)); err != nil {
		t.Fatal(err)
	}
	if _, err = HistoricalReply(root, c, original); !errors.Is(err, benchattempt.ErrPending) {
		t.Fatal("replaced DB absence restored owner", err)
	}
	if _, err = ObserveExchange(root, c, p, p, lookup); err != nil {
		t.Fatal(err)
	}
	reply, err := HistoricalReply(root, c, original)
	if err != nil || !reply.OK {
		t.Fatal("exact historical observation missing", err)
	}
	m, ok := reply.Result.(*benchworkspace.Mutation)
	if !ok || m.Grant == nil {
		t.Fatal("historical original grant not retained privately")
	}
	wrong := original
	wrong.RequestID = "different-original"
	if _, err = HistoricalReply(root, c, wrong); !errors.Is(err, benchattempt.ErrPending) {
		t.Fatal("historical token rebound to wrong request", err)
	}
	// Corruption of the exact saved ACK vetoes lookup; no original body fallback.
	lastACK := c.Exchanges[1]
	if err = os.WriteFile(filepath.Join(root, "cleanup-exchange-"+lastACK.ResponseSHA256), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if targets, err := LookupTargets(root, c, p); err != nil || len(targets) != 0 {
		t.Fatal("corrupt ACK allowed lookup", err)
	}
}
