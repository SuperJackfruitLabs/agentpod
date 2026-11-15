package benchworkspace

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func socketServer(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "bw-")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s")
	l, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", path)
	if err != nil {
		os.RemoveAll(dir)
		t.Fatal(err)
	}
	s := &http.Server{Handler: handler, ReadHeaderTimeout: time.Second}
	done := make(chan error, 1)
	go func() { done <- s.Serve(l) }()
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
		if err := <-done; !errors.Is(err, http.ErrServerClosed) {
			t.Error("server did not stop cleanly", err)
		}
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	return path
}

func leaseFixture(t *testing.T) (Request, []byte) {
	t.Helper()
	var corpus struct {
		Valid []struct {
			Body     json.RawMessage
			Expected struct {
				Operation, Key, Holder string
				RequestID              string `json:"request_id"`
			}
		}
	}
	load(t, "workspace-responses.json", &corpus)
	for _, c := range corpus.Valid {
		var r struct {
			OK     bool
			Result struct{ Workspace Workspace }
		}
		if c.Expected.Operation == "lease" && json.Unmarshal(c.Body, &r) == nil && r.OK {
			if r.Result.Workspace.Lease == nil {
				t.Fatal("lease fixture lacks owner")
			}
			request := Request{Version: Version, Operation: "lease", Key: c.Expected.Key, Holder: r.Result.Workspace.Lease.Holder, RequestID: c.Expected.RequestID}
			raw, _ := json.Marshal(request)
			if _, err := Parse(raw); err != nil {
				t.Fatal("invalid fixture request", err)
			}
			return request, c.Body
		}
	}
	t.Fatal("lease fixture missing")
	return Request{}, nil
}

func TestClientUsesExactlyOneExplicitUnixV2Request(t *testing.T) {
	request, body := leaseFixture(t)
	expected, _ := json.Marshal(request)
	var calls atomic.Int32
	path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		raw, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || r.URL.Path != "/v2/operations" || string(raw) != string(expected) || r.Header.Get("Authorization") != "" {
			t.Error("wrong private request")
		}
		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write(body); err != nil {
			t.Error(err)
		}
	})
	client, err := NewClient(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	out, err := client.Do(context.Background(), request)
	if err != nil || !out.OK || calls.Load() != 1 {
		t.Fatal(out, err, calls.Load())
	}
	mutation, ok := out.Result.(*Mutation)
	if !ok || mutation.Grant == nil || mutation.Grant.LeaseToken == "" {
		t.Fatal("authorized historical grant lost")
	}
}

func TestClientLostReplyRetainsUncertaintyAndNeverRetries(t *testing.T) {
	request, _ := leaseFixture(t)
	var calls atomic.Int32
	path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Error(err)
			return
		}
		calls.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	})
	client, err := NewClient(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	out, err := client.Do(context.Background(), request)
	var failure *Failure
	ok := errors.As(err, &failure)
	if out != nil || !ok || !failure.Uncertain || calls.Load() != 1 {
		t.Fatal(out, err, calls.Load())
	}
}

func TestClientDoesNotExposeGrantForAnotherRequestedHolder(t *testing.T) {
	var corpus struct {
		Valid []struct {
			Name     string
			Body     json.RawMessage
			Expected struct {
				Operation, Key string
				RequestID      string `json:"request_id"`
				Checkpoint     *bool
			}
		}
	}
	load(t, "workspace-responses.json", &corpus)
	cases := 0
	for _, fixture := range corpus.Valid {
		var body map[string]any
		if err := json.Unmarshal(fixture.Body, &body); err != nil {
			t.Fatal(err)
		}
		result, _ := body["result"].(map[string]any)
		if result["grant"] == nil || !oneOf(fixture.Expected.Operation, "lease", "run", "setup") {
			continue
		}
		cases++
		t.Run(fixture.Name, func(t *testing.T) {
			workspace := result["workspace"].(map[string]any)
			lease := workspace["lease"].(map[string]any)
			request := Request{Version: Version, Operation: fixture.Expected.Operation, Key: fixture.Expected.Key, RequestID: fixture.Expected.RequestID, Holder: lease["holder"].(string), Checkpoint: fixture.Expected.Checkpoint}
			if request.Operation == "run" {
				request.Arguments = []string{"true"}
			}
			raw, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Parse(raw); err != nil {
				t.Fatal("invalid request fixture", err)
			}
			status := http.StatusOK
			if body["ok"] == false {
				status = http.StatusUnprocessableEntity
			}
			// Prove the baseline is representable before changing only its owner.
			if _, err := ParseResponse(fixture.Body, status, request); err != nil {
				t.Fatal("invalid response fixture", err)
			}
			lease["holder"] = "run:another"
			foreign, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				if _, err := w.Write(foreign); err != nil {
					t.Error(err)
				}
			})
			client, err := NewClient(path, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			out, err := client.Do(t.Context(), request)
			var failure *Failure
			if out != nil || !errors.As(err, &failure) || failure.Code != "invalid_response" || !failure.Uncertain || failure.Response != nil || calls.Load() != 1 {
				t.Fatal("foreign grant exposed or outcome not retained as uncertain", out, err, calls.Load())
			}
		})
	}
	if cases != 4 {
		t.Fatal("expected success and partial-failure acquisition fixtures", cases)
	}
}

func TestClientRejectsUntrustedTransportWithoutFallbackOrMessageLeak(t *testing.T) {
	request, _ := leaseFixture(t)
	for _, test := range []struct {
		name, media, body string
		status            int
	}{
		{"redirect", "application/json", `{}`, 307},
		{"wrong-media", "text/plain", `PRIVATE-CANARY`, 200},
		{"v1", "application/json", `{"version":"superbench.v1","ok":true,"result":{}}`, 200},
		{"oversize-growth", "application/json", strings.Repeat(" ", MaxBody+1), 200},
		{"unknown-field", "application/json", `{"version":"superbench.v2","ok":false,"error":{"code":"unavailable","message":"PRIVATE-CANARY"},"unexpected":true}`, 503},
		{"uncertain-server", "application/json", `{"version":"superbench.v2","ok":false,"error":{"code":"unavailable","message":"PRIVATE-CANARY"}}`, 503},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v2/operations" {
					t.Error("fallback attempted")
				}
				w.Header().Set("Content-Type", test.media)
				w.Header().Set("Location", "http://outside.invalid/")
				w.WriteHeader(test.status)
				if _, err := io.WriteString(w, test.body); err != nil {
					t.Error(err)
				}
			})
			client, err := NewClient(path, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			_, err = client.Do(context.Background(), request)
			var failure *Failure
			ok := errors.As(err, &failure)
			if !ok || !failure.Uncertain || calls.Load() != 1 || strings.Contains(err.Error(), "PRIVATE") {
				t.Fatal(err, calls.Load())
			}
		})
	}
}
