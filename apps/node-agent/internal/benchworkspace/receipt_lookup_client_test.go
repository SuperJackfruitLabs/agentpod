package benchworkspace

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReceiptLookupEvidenceNeverResendsSourceOrTreatsAbsenceAsGrowth(t *testing.T) {
	target := ReceiptLookupRequest{Version: Version, Operation: "receipt_lookup", TargetRequestID: "original-request", TargetDigest: strings.Repeat("a", 64)}
	success, _ := json.Marshal(ReceiptLookupResponse{Version: Version, Operation: "receipt_lookup", OK: true, Result: &ReceiptLookupResult{TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: "absent"}})
	for _, tc := range []struct {
		name  string
		body  []byte
		lost  bool
		valid bool
	}{
		{name: "valid-ack", body: success, valid: true},
		{name: "wrong-target", body: bytes.Replace(success, []byte("original-request"), []byte("foreign-request"), 1)},
		{name: "malformed", body: []byte(`{"unknown":"private-invalid-marker"}`)},
		{name: "lost", lost: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v2/receipts/lookup" {
					t.Error("lookup sent to operation endpoint")
				}
				sent, e := io.ReadAll(r.Body)
				if e != nil {
					t.Error(e)
				}
				want, _ := json.Marshal(target)
				if !bytes.Equal(sent, want) {
					t.Error("sent target changed")
				}
				if tc.lost {
					conn, _, e := w.(http.Hijacker).Hijack()
					if e != nil {
						t.Error(e)
						return
					}
					_ = conn.Close()
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(tc.body)
			})
			client, e := NewClient(path, time.Second)
			if e != nil {
				t.Fatal(e)
			}
			defer client.Close()
			out, capture, e := client.LookupReceiptWithEvidence(t.Context(), target)
			if capture == nil || calls.Load() != 1 {
				t.Fatal("capture missing or request repeated", e)
			}
			want, _ := json.Marshal(target)
			if e := capture.Use(func(status int, sent, response []byte) error {
				if !bytes.Equal(sent, want) {
					t.Fatal("wrong request capture")
				}
				if tc.lost {
					if status != 0 || len(response) != 0 {
						t.Fatal("invented lost reply")
					}
				} else if status != 200 || !bytes.Equal(response, tc.body) {
					t.Fatal("response bytes changed")
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
			if tc.valid {
				if e != nil || out == nil || !out.OK || out.Result.State != "absent" {
					t.Fatal("ACK changed", e)
				}
			} else {
				var failure *ReceiptLookupFailure
				if !errors.As(e, &failure) || !failure.Uncertain || out != nil || strings.Contains(e.Error(), "private-invalid-marker") {
					t.Fatal("captured bytes became authority", e)
				}
			}
		})
	}
}
