package benchworkspace

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCancellationUnixTransportNeverFallsBackOrInfersFence(t *testing.T) {
	target := CancelRequest{Version: Version, Operation: "cancel", TargetRequestID: "run-example", TargetDigest: strings.Repeat("a", 64)}
	observation := func(state string) string {
		raw, err := json.Marshal(CancelResponse{Version: Version, Operation: "cancel", OK: true, Result: &CancelObservation{TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: state}})
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	for _, c := range []struct {
		name, body, media, state string
		status                   int
		lost, failure            bool
	}{
		{name: "intent-only", body: observation("cancel_requested"), state: "cancel_requested"},
		{name: "producer-observation", body: observation("cancelled"), state: "cancelled"},
		{name: "historical-completion", body: observation("already_completed"), state: "already_completed"},
		{name: "refused", status: 503, body: `{"version":"superbench.v2","operation":"cancel","ok":false,"error":{"code":"unavailable","message":"private-error-marker"}}`, failure: true},
		{name: "wrong-target", body: strings.Replace(observation("cancelled"), "run-example", "other-request", 1), failure: true},
		{name: "foreign-grant", body: strings.Replace(observation("cancelled"), `"state":"cancelled"`, `"state":"cancelled","lease_token":"private-error-marker"`, 1), failure: true},
		{name: "oversize", body: observation("cancelled") + strings.Repeat(" ", MaxBody), failure: true},
		{name: "wrong-media", media: "text/plain", body: observation("cancelled"), failure: true},
		{name: "redirect", status: 307, body: observation("cancelled"), failure: true},
		{name: "opaque-error", status: 400, body: `{"version":"superbench.v2","ok":false,"error":{"code":"invalid_request","message":"private-error-marker"}}`, failure: true},
		{name: "lost-reply", lost: true, failure: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			var calls atomic.Int32
			socket := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					return
				}
				parsed, err := ParseCancelRequest(raw)
				if err != nil || parsed != target || r.Method != "POST" || r.URL.Path != "/v2/operations" || r.Header.Get("Authorization") != "" {
					t.Error("wrong cancellation request")
				}
				if c.lost {
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					if err = conn.Close(); err != nil {
						t.Error(err)
					}
					return
				}
				media := c.media
				if media == "" {
					media = "application/json"
				}
				w.Header().Set("Content-Type", media)
				w.Header().Set("Location", "http://another-host.invalid/v1/operations")
				status := c.status
				if status == 0 {
					status = 200
				}
				w.WriteHeader(status)
				if _, err := io.WriteString(w, c.body); err != nil {
					t.Error(err)
				}
			})
			client, err := NewClient(socket, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			response, err := client.Cancel(t.Context(), target)
			if calls.Load() != 1 {
				t.Fatal("cancellation retried or redirected", calls.Load())
			}
			if c.failure {
				var failure *CancelFailure
				if !errors.As(err, &failure) || !failure.Uncertain || strings.Contains(err.Error(), "private-error-marker") {
					t.Fatal("failure did not retain redacted uncertainty", err)
				}
				if response != nil && response.OK {
					t.Fatal("invalid response supplied a successful observation")
				}
				return
			}
			if err != nil || response == nil || response.Result == nil || response.Result.State != c.state {
				t.Fatal("observation lost", response, err)
			}
		})
	}
}
