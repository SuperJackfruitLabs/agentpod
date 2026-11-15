package superbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func socketClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	parent, err := os.MkdirTemp("", "sb-socket-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(parent) })
	socket := filepath.Join(parent, "s")
	l, e := (&net.ListenConfig{}).Listen(context.Background(), "unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	s := &http.Server{Handler: h, ReadHeaderTimeout: time.Second}
	go func() { _ = s.Serve(l) }()
	t.Cleanup(func() { _ = s.Close() })
	c, e := NewClient(socket, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(c.Close)
	return c
}
func runRequest() Request {
	return Request{Version: Version, Operation: "run", Key: "card_example", Holder: "run_example", RequestID: "run-example", Arguments: []string{"sh", "-c", "printf hello"}}
}
func goodRun() string {
	return `{"version":"superbench.v1","operation":"run","request_id":"run-example","ok":true,"result":{"bench":{"key":"card_example","path":"/checkout","checkpoint":"` + strings.Repeat("a", 40) + `"},"execution":{"id":"exec1","phase":"stopped"},"exit_code":0}}`
}
func TestRunClientCompletion(t *testing.T) {
	var count atomic.Int32
	c := socketClient(t, func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		if r.URL.Path != "/v1/operations" || r.Method != "POST" || r.Header.Get("Authorization") != "" {
			t.Error("invalid socket request")
		}
		var req Request
		if e := json.NewDecoder(r.Body).Decode(&req); e != nil || req.RequestID != "run-example" {
			t.Error("request binding lost")
		}
		fmt.Fprint(w, goodRun())
	})
	out, e := c.Do(context.Background(), runRequest())
	if e != nil || out.Result.Bench.Lease != nil || count.Load() != 1 {
		t.Fatalf("completion failed: %v", e)
	}
}
func TestClientRejectsAmbiguousCompletion(t *testing.T) {
	for name, body := range map[string]string{"wrong receipt": strings.Replace(goodRun(), "run-example", "other", 1), "duplicate": strings.Replace(goodRun(), `"ok":true`, `"ok":false,"ok":true`, 1), "running": strings.Replace(goodRun(), "stopped", "running", 1), "no exit": strings.Replace(goodRun(), `,"exit_code":0`, "", 1), "lease retained": strings.Replace(goodRun(), `"path":"/checkout"`, `"lease":{"mode":"supervised","holder":"run_example","token":"`+strings.Repeat("a", 32)+`"},"path":"/checkout"`, 1), "trailing": goodRun() + `{}`, "oversized": strings.Repeat("x", MaxResponse+1)} {
		t.Run(name, func(t *testing.T) {
			c := socketClient(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) })
			_, e := c.Do(context.Background(), runRequest())
			var f *Failure
			if !errors.As(e, &f) || !f.Uncertain {
				t.Fatal("ambiguous completion authorized")
			}
		})
	}
}
func TestUncertainSocketNeverRedispatches(t *testing.T) {
	var count atomic.Int32
	c := socketClient(t, func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		conn, _, _ := w.(http.Hijacker).Hijack()
		_ = conn.Close()
	})
	_, e := c.Do(context.Background(), runRequest())
	var f *Failure
	if !errors.As(e, &f) || !f.Uncertain || count.Load() != 1 {
		t.Fatalf("uncertain retry: %v %d", e, count.Load())
	}
}
func TestFailureRetainsCapabilityWithoutEcho(t *testing.T) {
	token := strings.Repeat("a", 32)
	c := socketClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		fmt.Fprintf(w, `{"version":"superbench.v1","operation":"run","request_id":"run-example","ok":false,"error":{"code":"operation_failed","message":"%s"},"result":{"bench":{"key":"card_example","path":"/checkout","checkpoint":"%s","lease":{"mode":"supervised","holder":"run_example","token":"%s"}}}}`, token, strings.Repeat("b", 40), token)
	})
	out, e := c.Do(context.Background(), runRequest())
	if e == nil || strings.Contains(e.Error(), token) || out.Result.Bench.Lease.Token != token {
		t.Fatal("lost retained ownership or leaked token")
	}
}
func TestV1UnknownResponseFieldsRemainCompatible(t *testing.T) {
	c := socketClient(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, strings.Replace(goodRun(), `"ok":true`, `"future":{"new":true},"ok":true`, 1))
	})
	if _, e := c.Do(context.Background(), runRequest()); e != nil {
		t.Fatal(e)
	}
}
func TestMissingSocketUncertain(t *testing.T) {
	c, e := NewClient(filepath.Join(t.TempDir(), "absent"), time.Second)
	if e != nil {
		t.Fatal(e)
	}
	_, e = c.Do(context.Background(), runRequest())
	var f *Failure
	if !errors.As(e, &f) || !f.Uncertain {
		t.Fatal(e)
	}
}

func TestFailureCannotExposeForeignOrMalformedOwnership(t *testing.T) {
	base := `{"version":"superbench.v1","operation":"run","request_id":"run-example","ok":false,"error":{"code":"operation_failed","message":"private"},"result":{"bench":{"key":"card_example","path":"/checkout","checkpoint":"` + strings.Repeat("b", 40) + `","lease":{"mode":"supervised","holder":"run_example","token":"` + strings.Repeat("a", 32) + `"}}}}`
	for name, body := range map[string]string{"foreign key": strings.Replace(base, "card_example", "other", 1), "foreign holder": strings.Replace(base, `"holder":"run_example"`, `"holder":"other"`, 1), "malformed token": strings.Replace(base, strings.Repeat("a", 32), "bad", 1), "extra grant": strings.Replace(base, `"result":{`, `"result":{"benches":[],`, 1), "malformed bench": `{"version":"superbench.v1","operation":"run","request_id":"run-example","ok":false,"error":{"code":"operation_failed","message":"private"},"result":{"bench":"invalid"}}`} {
		t.Run(name, func(t *testing.T) {
			c := socketClient(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(422); fmt.Fprint(w, body) })
			out, e := c.Do(context.Background(), runRequest())
			var f *Failure
			if out != nil || !errors.As(e, &f) || !f.Uncertain || f.Response != nil {
				t.Fatalf("foreign capability exposed: %v", e)
			}
		})
	}
}
func TestReadOnlyCannotReturnGrantInOtherProjection(t *testing.T) {
	for _, op := range []string{"status", "host_status"} {
		t.Run(op, func(t *testing.T) {
			c := socketClient(t, func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintf(w, `{"version":"superbench.v1","operation":"%s","ok":true,"result":{"benches":[],"bench":{"key":"secret","lease":{"token":"%s"}}}}`, op, strings.Repeat("a", 32))
			})
			out, e := c.Do(context.Background(), Request{Version: Version, Operation: op})
			if e == nil || out != nil {
				t.Fatal("read-only grant exposed")
			}
		})
	}
}

func TestOperationSpecificOwnershipPostconditions(t *testing.T) {
	falseValue := false
	trueValue := true
	base := Bench{Key: "k", Path: "/checkout", Checkpoint: strings.Repeat("a", 40)}
	execution := &Execution{ID: "e", Phase: "stopped"}
	exit := 0
	for _, tc := range []struct {
		name   string
		req    Request
		result Result
	}{
		{"lease missing grant", Request{Operation: "lease", Key: "k", Holder: "h"}, Result{Bench: &base}},
		{"run false missing grant", Request{Operation: "run", Key: "k", Holder: "h", Checkpoint: &falseValue}, Result{Bench: &base, Execution: execution, ExitCode: &exit}},
		{"warm create retained", Request{Operation: "create", Key: "k", Initialize: &trueValue}, Result{Bench: &Bench{Key: "k", Path: "/checkout", Checkpoint: base.Checkpoint, Lease: &Lease{Holder: "initialization", Mode: "cooperative", Token: strings.Repeat("b", 32)}}}},
		{"foreign lease", Request{Operation: "lease", Key: "k", Holder: "h"}, Result{Bench: &Bench{Key: "k", Path: "/checkout", Checkpoint: base.Checkpoint, Lease: &Lease{Holder: "other", Mode: "cooperative", Token: strings.Repeat("b", 32)}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if validateResult(tc.req, &tc.result) == nil {
				t.Fatal("invalid ownership accepted")
			}
		})
	}
}

func TestStopAcceptsReservedInitializationWithoutInventingExecution(t *testing.T) {
	for _, op := range []string{"stop", "stop_admin"} {
		r := Result{Bench: &Bench{Key: "k", Path: "/checkout", Checkpoint: strings.Repeat("a", 40), Lease: &Lease{Mode: "cooperative", Holder: "initialization", Token: strings.Repeat("b", 32)}}}
		if e := validateResult(Request{Operation: op, Key: "k"}, &r); e != nil {
			t.Fatal(e)
		}
		if r.Bench.Lease.Execution != nil {
			t.Fatal("invented fence evidence")
		}
		r.Bench.Lease.Execution = &Execution{ID: "e", Phase: "running"}
		if e := validateResult(Request{Operation: op, Key: "k"}, &r); e == nil {
			t.Fatal("running stop accepted")
		}
	}
}

func TestProducerFailureNullBenchIsDefiniteNotFound(t *testing.T) {
	c := socketClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		fmt.Fprint(w, `{"version":"superbench.v1","operation":"checkpoint","ok":false,"error":{"code":"not_found","message":"unknown bench"},"result":{"bench":null}}`)
	})
	out, e := c.Do(context.Background(), Request{Version: Version, Operation: "checkpoint", Key: "k", LeaseToken: strings.Repeat("a", 32)})
	var f *Failure
	if out == nil || !errors.As(e, &f) || f.Uncertain || f.Code != "not_found" || out.Result.Bench != nil {
		t.Fatalf("definite failure misclassified %v", e)
	}
}
func TestCheckpointFailureRedactionAndStopTokenBinding(t *testing.T) {
	for _, tc := range []struct {
		name, op, token string
		valid           bool
	}{{"redacted checkpoint", "checkpoint", "", true}, {"checkpoint grant", "checkpoint", strings.Repeat("a", 32), false}, {"same stop owner", "stop", strings.Repeat("a", 32), true}, {"foreign stop owner", "stop", strings.Repeat("b", 32), false}} {
		t.Run(tc.name, func(t *testing.T) {
			c := socketClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(409)
				fmt.Fprintf(w, `{"version":"superbench.v1","operation":"%s","ok":false,"error":{"code":"conflict","message":"retained"},"result":{"bench":{"key":"k","path":"/checkout","checkpoint":"%s","lease":{"holder":"h","mode":"supervised","token":"%s"}}}}`, tc.op, strings.Repeat("c", 40), tc.token)
			})
			out, e := c.Do(context.Background(), Request{Version: Version, Operation: tc.op, Key: "k", LeaseToken: strings.Repeat("a", 32)})
			if (out != nil) != tc.valid || e == nil {
				t.Fatalf("incorrect retained-result acceptance %v", e)
			}
		})
	}
}
