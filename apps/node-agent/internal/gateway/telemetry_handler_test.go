package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/otelenv"
)

func newTestTelemetryHandler(path string) (*telemetryHandler, chan int) {
	exited := make(chan int, 1)
	h := &telemetryHandler{
		inner: HandlerFunc(func(context.Context, string, json.RawMessage, func(int, string, bool, string) error) (any, bool, error) {
			return "inner", false, nil
		}),
		path:  func() (string, error) { return path, nil },
		exit:  func(c int) { exited <- c },
		delay: 0,
	}
	return h, exited
}

func callTelemetry(t *testing.T, h *telemetryHandler, exited chan int, verb, params string) (map[string]any, bool) {
	t.Helper()
	res, streamed, err := h.Handle(context.Background(), verb, json.RawMessage(params), nil)
	if err != nil || streamed {
		t.Fatalf("err=%v streamed=%v", err, streamed)
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("result %T", res)
	}
	select {
	case <-exited:
		return m, true
	case <-time.After(300 * time.Millisecond):
		return m, false
	}
}

func TestTelemetryStatus(t *testing.T) {
	p := filepath.Join(t.TempDir(), "otel.env")
	h, ex := newTestTelemetryHandler(p)
	m, exited := callTelemetry(t, h, ex, "telemetry.status", `{}`)
	if exited || m["ok"] != true || m["path"] != p || m["endpoint"] != "" || m["enabled"] != false {
		t.Fatalf("absent: %v exited=%v", m, exited)
	}
	if _, err := otelenv.SetEndpoint(p, "http://10.0.0.1:4318"); err != nil {
		t.Fatal(err)
	}
	m, _ = callTelemetry(t, h, ex, "telemetry.status", ``)
	if m["endpoint"] != "http://10.0.0.1:4318" || m["enabled"] != true {
		t.Fatalf("enabled: %v", m)
	}
}

func TestTelemetrySetChangedRestarts(t *testing.T) {
	p := filepath.Join(t.TempDir(), "otel.env")
	h, ex := newTestTelemetryHandler(p)
	m, exited := callTelemetry(t, h, ex, "telemetry.set", `{"endpoint":"http://10.0.0.1:4318"}`)
	if !exited || m["ok"] != true || m["changed"] != true || m["restarting"] != true ||
		m["endpoint"] != "http://10.0.0.1:4318" || m["enabled"] != true {
		t.Fatalf("%v exited=%v", m, exited)
	}
	st, _ := otelenv.Read(p)
	if !st.Enabled || st.Endpoint != "http://10.0.0.1:4318" {
		t.Fatalf("file: %+v", st)
	}
	// Same again: unchanged, no restart.
	m, exited = callTelemetry(t, h, ex, "telemetry.set", `{"endpoint":"http://10.0.0.1:4318"}`)
	if exited || m["ok"] != true || m["changed"] != false || m["restarting"] != false {
		t.Fatalf("repeat: %v exited=%v", m, exited)
	}
	// Off: changed, restarts; off again: no-op.
	m, exited = callTelemetry(t, h, ex, "telemetry.set", `{"off":true}`)
	if !exited || m["changed"] != true || m["enabled"] != false || m["restarting"] != true {
		t.Fatalf("off: %v exited=%v", m, exited)
	}
	m, exited = callTelemetry(t, h, ex, "telemetry.set", `{"off":true}`)
	if exited || m["changed"] != false || m["restarting"] != false {
		t.Fatalf("off again: %v exited=%v", m, exited)
	}
}

func TestTelemetrySetRejectsBadInput(t *testing.T) {
	for name, params := range map[string]string{
		"both":         `{"endpoint":"http://a:1","off":true}`,
		"neither":      `{}`,
		"empty":        `{"endpoint":""}`,
		"off false":    `{"off":false}`,
		"wrong type":   `{"endpoint":5}`,
		"malformed":    `{`,
		"no params":    ``,
		"ftp":          `{"endpoint":"ftp://a"}`,
		"injection":    `{"endpoint":"http://a:1\nEVIL=1"}`,
		"equals":       `{"endpoint":"http://a:1/?x=y"}`,
		"off + empty":  `{"endpoint":"","off":true}`,
		"endpoint+off": `{"endpoint":"http://a:1","off":false}`,
	} {
		t.Run(name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "otel.env")
			h, ex := newTestTelemetryHandler(p)
			m, exited := callTelemetry(t, h, ex, "telemetry.set", params)
			if exited || m["ok"] != false || m["error"] == nil || m["error"] == "" {
				t.Fatalf("%v exited=%v", m, exited)
			}
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Fatalf("file touched: %v", err)
			}
		})
	}
}

func TestTelemetryUnsupported(t *testing.T) {
	for _, perr := range []error{otelenv.ErrUnsupported, errors.New("no home")} {
		h, ex := newTestTelemetryHandler("")
		h.path = func() (string, error) { return "", perr }
		for _, verb := range []string{"telemetry.status", "telemetry.set"} {
			m, exited := callTelemetry(t, h, ex, verb, `{"off":true}`)
			if exited || m["ok"] != false || m["unsupported"] != true || m["error"] != perr.Error() {
				t.Fatalf("%s: %v exited=%v", verb, m, exited)
			}
		}
	}
}

// A node that is not the agentpod-node systemd service (container, fixed image, `apn run`
// in tmux) must answer unsupported for both verbs without writing a file or exiting:
// exiting there stops a sandbox or loses a hand-started node for good (C1).
func TestTelemetryNotUnderServiceWritesNothingAndStaysUp(t *testing.T) {
	for name, cgroup := range map[string]string{
		"container": "0::/\n",
		"docker v1": "1:name=systemd:/docker/3f2a9c\n",
		"tmux":      "0::/user.slice/user-1000.slice/session-4.scope\n",
	} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			h, ex := newTestTelemetryHandler("")
			h.path = func() (string, error) { return otelenv.ServicePathFromCgroup(cgroup, home) }
			for _, tc := range []struct{ verb, params string }{
				{"telemetry.status", `{}`},
				{"telemetry.set", `{"endpoint":"http://10.0.0.1:4318"}`},
				{"telemetry.set", `{"off":true}`},
			} {
				m, exited := callTelemetry(t, h, ex, tc.verb, tc.params)
				e, _ := m["error"].(string)
				if exited || m["ok"] != false || m["unsupported"] != true ||
					!strings.HasPrefix(e, "node is not running under the agentpod-node systemd service") {
					t.Fatalf("%s %s: %v exited=%v", tc.verb, tc.params, m, exited)
				}
			}
			if _, err := os.Stat(otelenv.UserPath(home)); !os.IsNotExist(err) {
				t.Fatalf("file written: %v", err)
			}
			if entries, _ := os.ReadDir(home); len(entries) != 0 {
				t.Fatalf("home touched: %v", entries)
			}
		})
	}
}

func TestTelemetryStatusReportsEffectiveEndpoint(t *testing.T) {
	p := filepath.Join(t.TempDir(), "otel.env")
	h, ex := newTestTelemetryHandler(p)
	h.effective = "http://started-with:4318"
	if _, err := otelenv.SetEndpoint(p, "http://10.0.0.1:4318"); err != nil {
		t.Fatal(err)
	}
	m, _ := callTelemetry(t, h, ex, "telemetry.status", `{}`)
	if m["effective"] != "http://started-with:4318" || m["endpoint"] != "http://10.0.0.1:4318" {
		t.Fatalf("%v", m)
	}
}

func TestTelemetryDelegatesAndForwardsFrames(t *testing.T) {
	h, _ := newTestTelemetryHandler("x")
	if res, _, _ := h.Handle(context.Background(), "ping", nil, nil); res != "inner" {
		t.Fatalf("not delegated: %v", res)
	}
	fh := &telFrameRecorder{}
	h.inner = fh
	if err := h.HandleFrame("input", "1", nil); err != nil || !fh.got {
		t.Fatalf("frame not forwarded: %v", err)
	}
	h.inner = HandlerFunc(nil)
	if err := h.HandleFrame("input", "1", nil); err != nil {
		t.Fatal(err)
	}
}

type telFrameRecorder struct{ got bool }

func (f *telFrameRecorder) Handle(context.Context, string, json.RawMessage, func(int, string, bool, string) error) (any, bool, error) {
	return nil, false, nil
}
func (f *telFrameRecorder) HandleFrame(string, string, json.RawMessage) error {
	f.got = true
	return nil
}

// Round trip through the real dispatcher: a req frame arrives, the file changes,
// the res frame carries the structured result, and exit is scheduled.
func TestTelemetryBrokerRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "otel.env")
	h, exited := newTestTelemetryHandler(p)

	got := make(chan string, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := websocket.Accept(w, r, nil)
		defer c.Close(websocket.StatusNormalClosure, "")
		for i, req := range []string{
			`{"type":"req","id":"1","verb":"telemetry.set","params":{"endpoint":"http://10.0.0.1:4318"}}`,
			`{"type":"req","id":"2","verb":"telemetry.set","params":{"endpoint":"ftp://bad"}}`,
		} {
			c.Write(context.Background(), websocket.MessageText, []byte(req))
			_, data, _ := c.Read(context.Background())
			got <- string(data)
			if i == 0 {
				select {
				case <-exited:
				case <-time.After(2 * time.Second):
					got <- "NO EXIT"
				}
			}
		}
	}))
	defer srv.Close()
	c, _, _ := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	go serve(context.Background(), c, h)

	recv := func() string {
		select {
		case m := <-got:
			return m
		case <-time.After(3 * time.Second):
			t.Fatal("no response")
			return ""
		}
	}
	m := recv()
	for _, want := range []string{`"type":"res"`, `"ok":true`, `"changed":true`, `"restarting":true`} {
		if !strings.Contains(m, want) {
			t.Fatalf("res missing %s: %s", want, m)
		}
	}
	if st, _ := otelenv.Read(p); st.Endpoint != "http://10.0.0.1:4318" {
		t.Fatalf("file not changed: %+v", st)
	}
	before, _ := os.ReadFile(p)
	m = recv()
	if !strings.Contains(m, `"ok":false`) {
		t.Fatalf("bad endpoint: %s", m)
	}
	if after, _ := os.ReadFile(p); string(after) != string(before) {
		t.Fatal("file touched by invalid request")
	}
	select {
	case <-exited:
		t.Fatal("exit scheduled for invalid request")
	case <-time.After(300 * time.Millisecond):
	}
}
