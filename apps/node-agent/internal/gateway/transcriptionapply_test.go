package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

const applyTestKey = "sk-apply-secret-never-in-errors"

type applyRecorder struct {
	calls   []string
	written TranscriptionConfig
	dir     string
}

// applyDeps returns deps that record every call in order; override fields
// per test.
func applyDeps(t *testing.T, rec *applyRecorder, cfg TranscriptionConfig) TranscriptionApplyDeps {
	t.Helper()
	return TranscriptionApplyDeps{
		Resolver:        WorkspaceFunc(func(string) (string, error) { return "/home/u/.hermes/profiles/analyst-echo", nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"health", "lifecycle"}, nil },
		Fetch: func(_ context.Context, stationID string) (TranscriptionConfig, error) {
			rec.calls = append(rec.calls, "fetch:"+stationID)
			return cfg, nil
		},
		Write: func(dir string, c TranscriptionConfig) error {
			rec.calls = append(rec.calls, "write")
			rec.written, rec.dir = c, dir
			return nil
		},
		Restart: func(key string) error {
			rec.calls = append(rec.calls, "restart:"+key)
			return nil
		},
	}
}

var onConfig = TranscriptionConfig{Enabled: true, URL: "http://100.78.52.87:8840", APIKey: applyTestKey, Model: "large-v3-turbo"}

const applyParams = `{"key":"hermes:analyst-echo","stationId":"st_db_1"}`

func TestTranscriptionApplyPassesOtherVerbsThrough(t *testing.T) {
	rec := &applyRecorder{}
	h := NewTranscriptionApplyHandler(matrixAdoptPassthrough(), applyDeps(t, rec, onConfig))
	got, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil || got != "inner:health" {
		t.Fatalf("got %v, %v; want the inner handler's result", got, err)
	}
	if len(rec.calls) != 0 {
		t.Errorf("calls = %v, want none for another verb", rec.calls)
	}
}

func TestTranscriptionApplyWritesThenRestarts(t *testing.T) {
	rec := &applyRecorder{}
	h := NewTranscriptionApplyHandler(matrixAdoptPassthrough(), applyDeps(t, rec, onConfig))
	res, _, err := h.Handle(t.Context(), "transcription.apply", json.RawMessage(applyParams), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	want := []string{"fetch:st_db_1", "write", "restart:hermes:analyst-echo"}
	if strings.Join(rec.calls, ",") != strings.Join(want, ",") {
		t.Errorf("calls = %v, want %v", rec.calls, want)
	}
	if rec.dir != "/home/u/.hermes/profiles/analyst-echo" || rec.written != onConfig {
		t.Errorf("wrote %+v into %q", rec.written, rec.dir)
	}
	b, _ := json.Marshal(res)
	if string(b) != `{"applied":true,"mode":"on","model":"large-v3-turbo","restarted":true}` {
		t.Errorf("result = %s", b)
	}
	if strings.Contains(string(b), applyTestKey) {
		t.Error("the result carries the API key")
	}
}

func TestTranscriptionApplyDisabled(t *testing.T) {
	rec := &applyRecorder{}
	h := NewTranscriptionApplyHandler(matrixAdoptPassthrough(), applyDeps(t, rec, TranscriptionConfig{Enabled: false}))
	res, _, err := h.Handle(t.Context(), "transcription.apply", json.RawMessage(applyParams), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	b, _ := json.Marshal(res)
	if string(b) != `{"applied":true,"mode":"off","model":null,"restarted":true}` {
		t.Errorf("result = %s", b)
	}
	if rec.written.Enabled {
		t.Error("wrote an enabled setting for a disabled one")
	}
}

// TestTranscriptionApplyRefusesUnsupportedHarness: only Hermes has a writer,
// and a refusal comes before the hub is asked for a key this node could not
// store.
func TestTranscriptionApplyRefusesUnsupportedHarness(t *testing.T) {
	rec := &applyRecorder{}
	deps := applyDeps(t, rec, onConfig)
	deps.HarnessFor = func(string) (string, error) { return "openclaw", nil }
	h := NewTranscriptionApplyHandler(matrixAdoptPassthrough(), deps)
	_, _, err := h.Handle(t.Context(), "transcription.apply", json.RawMessage(`{"key":"openclaw:x","stationId":"s"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "openclaw") {
		t.Fatalf("err = %v, want a refusal naming the harness", err)
	}
	if len(rec.calls) != 0 {
		t.Errorf("calls = %v, want nothing fetched, written or restarted", rec.calls)
	}
}

func TestTranscriptionApplyBadParams(t *testing.T) {
	rec := &applyRecorder{}
	h := NewTranscriptionApplyHandler(matrixAdoptPassthrough(), applyDeps(t, rec, onConfig))
	for _, p := range []string{`{"key":"hermes:x"}`, `{"stationId":"s"}`, `nope`} {
		if _, _, err := h.Handle(t.Context(), "transcription.apply", json.RawMessage(p), nil); err == nil {
			t.Errorf("params %s: want an error", p)
		}
	}
	if len(rec.calls) != 0 {
		t.Errorf("calls = %v, want none", rec.calls)
	}
}

// TestTranscriptionApplyWithoutLifecycleWritesButDoesNotRestart: a profile
// sharing the root gateway (issue #273) has no lifecycle capability. The
// config is still written — it is that gateway's to pick up — but nothing
// here restarts it.
func TestTranscriptionApplyWithoutLifecycleWritesButDoesNotRestart(t *testing.T) {
	rec := &applyRecorder{}
	deps := applyDeps(t, rec, onConfig)
	deps.CapabilitiesFor = func(string) ([]string, error) { return []string{"health"}, nil }
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	h := NewTranscriptionApplyHandler(matrixAdoptPassthrough(), deps)
	res, _, err := h.Handle(t.Context(), "transcription.apply", json.RawMessage(applyParams), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if strings.Join(rec.calls, ",") != "fetch:st_db_1,write" {
		t.Errorf("calls = %v, want a fetch and a write and no restart", rec.calls)
	}
	b, _ := json.Marshal(res)
	if !strings.Contains(string(b), `"restarted":false`) || !strings.Contains(string(b), `"applied":true`) {
		t.Errorf("result = %s", b)
	}
	if !strings.Contains(logs.String(), "#273") {
		t.Errorf("log should say why nothing restarted: %q", logs.String())
	}
	if strings.Contains(logs.String(), applyTestKey) {
		t.Error("the log carries the API key")
	}
}

func TestTranscriptionApplyRestartFailureSaysTheConfigIsWritten(t *testing.T) {
	rec := &applyRecorder{}
	deps := applyDeps(t, rec, onConfig)
	deps.Restart = func(string) error { return errors.New("systemctl said no") }
	h := NewTranscriptionApplyHandler(matrixAdoptPassthrough(), deps)
	_, _, err := h.Handle(t.Context(), "transcription.apply", json.RawMessage(applyParams), nil)
	if err == nil {
		t.Fatal("want an error when the restart fails")
	}
	if !strings.Contains(err.Error(), "written") || !strings.Contains(err.Error(), "systemctl said no") {
		t.Errorf("error %q should say the config IS written, and why the restart failed", err)
	}
}

func TestTranscriptionApplyWriteFailureDoesNotRestart(t *testing.T) {
	rec := &applyRecorder{}
	deps := applyDeps(t, rec, onConfig)
	deps.Write = func(string, TranscriptionConfig) error {
		rec.calls = append(rec.calls, "write")
		return errors.New("hermes: no .env")
	}
	h := NewTranscriptionApplyHandler(matrixAdoptPassthrough(), deps)
	_, _, err := h.Handle(t.Context(), "transcription.apply", json.RawMessage(applyParams), nil)
	if err == nil {
		t.Fatal("want an error")
	}
	if strings.Contains(strings.Join(rec.calls, ","), "restart") {
		t.Errorf("restarted after a failed write: %v", rec.calls)
	}
}

func TestTranscriptionApplyFetchFailure(t *testing.T) {
	rec := &applyRecorder{}
	deps := applyDeps(t, rec, onConfig)
	deps.Fetch = func(context.Context, string) (TranscriptionConfig, error) {
		return TranscriptionConfig{}, errors.New("hub refused (status 403)")
	}
	h := NewTranscriptionApplyHandler(matrixAdoptPassthrough(), deps)
	if _, _, err := h.Handle(t.Context(), "transcription.apply", json.RawMessage(applyParams), nil); err == nil {
		t.Fatal("want an error")
	}
	if len(rec.calls) != 0 {
		t.Errorf("calls = %v, want nothing written or restarted", rec.calls)
	}
}

func TestHTTPTranscriptionFetcher(t *testing.T) {
	var gotAuth, gotPath, gotMethod string
	status := http.StatusOK
	body := `{"enabled":true,"url":"http://stt:8840","apiKey":"` + applyTestKey + `","model":"large-v3-turbo"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath, gotMethod = r.Header.Get("Authorization"), r.URL.EscapedPath(), r.Method
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	fetch := NewHTTPTranscriptionFetcher(srv.URL+"/", "node 1", "sekret")
	cfg, err := fetch(t.Context(), "st/1")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/nodes/node%201/stations/st%2F1/transcription" {
		t.Errorf("%s %s", gotMethod, gotPath)
	}
	if gotAuth != "Bearer node 1:sekret" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if cfg != (TranscriptionConfig{Enabled: true, URL: "http://stt:8840", APIKey: applyTestKey, Model: "large-v3-turbo"}) {
		t.Errorf("cfg = %+v", cfg)
	}

	// A refusal: the body is never read into the error.
	status = http.StatusForbidden
	body = `{"error":"station not hosted by this node","apiKey":"` + applyTestKey + `"}`
	_, err = fetch(t.Context(), "st/1")
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("err = %v, want a refusal naming the status", err)
	}
	if strings.Contains(err.Error(), applyTestKey) || strings.Contains(err.Error(), "not hosted") {
		t.Errorf("error carries the response body: %q", err)
	}

	// A malformed 200: the decode error does not echo the body either.
	status = http.StatusOK
	body = `{"enabled":true,"apiKey":"` + applyTestKey + `"`
	_, err = fetch(t.Context(), "st/1")
	if err == nil {
		t.Fatal("want a decode error")
	}
	if strings.Contains(err.Error(), applyTestKey) {
		t.Errorf("error carries the key: %q", err)
	}
}
