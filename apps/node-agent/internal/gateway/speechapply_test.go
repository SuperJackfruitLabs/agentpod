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

const speechTestKey = "sk-speech-secret-never-in-errors"

type speechRecorder struct {
	calls   []string
	written SpeechConfig
	dir     string
}

// speechDeps returns deps that record every call in order; the writer
// reports autoSpeak. Override fields per test.
func speechDeps(t *testing.T, rec *speechRecorder, cfg SpeechConfig, autoSpeak bool) SpeechApplyDeps {
	t.Helper()
	return SpeechApplyDeps{
		Resolver:        WorkspaceFunc(func(string) (string, error) { return "/root/.hermes/profiles/writer-quill", nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"health", "lifecycle"}, nil },
		Fetch: func(_ context.Context, stationID string) (SpeechConfig, error) {
			rec.calls = append(rec.calls, "fetch:"+stationID)
			return cfg, nil
		},
		Write: func(dir string, c SpeechConfig) (bool, error) {
			rec.calls = append(rec.calls, "write")
			rec.written, rec.dir = c, dir
			return autoSpeak, nil
		},
		Restart: func(key string) error {
			rec.calls = append(rec.calls, "restart:"+key)
			return nil
		},
	}
}

var speechOn = SpeechConfig{
	Enabled: true, URL: "http://100.78.52.87:8841", APIKey: speechTestKey,
	Voice: "af_heart:60+af_bella:40", SpeakMode: "always",
}

const speechParams = `{"key":"hermes:writer-quill","stationId":"st_db_1"}`

func TestSpeechApplyPassesOtherVerbsThrough(t *testing.T) {
	rec := &speechRecorder{}
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), speechDeps(t, rec, speechOn, true))
	for _, verb := range []string{"health", "transcription.apply"} {
		got, _, err := h.Handle(t.Context(), verb, json.RawMessage(`{}`), nil)
		if err != nil || got != "inner:"+verb {
			t.Fatalf("%s: got %v, %v; want the inner handler's result", verb, got, err)
		}
	}
	if len(rec.calls) != 0 {
		t.Errorf("calls = %v, want none for another verb", rec.calls)
	}
}

func TestSpeechApplyWritesThenRestarts(t *testing.T) {
	rec := &speechRecorder{}
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), speechDeps(t, rec, speechOn, true))
	res, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(speechParams), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	want := []string{"fetch:st_db_1", "write", "restart:hermes:writer-quill"}
	if strings.Join(rec.calls, ",") != strings.Join(want, ",") {
		t.Errorf("calls = %v, want %v", rec.calls, want)
	}
	if rec.dir != "/root/.hermes/profiles/writer-quill" || rec.written != speechOn {
		t.Errorf("wrote %+v into %q", rec.written, rec.dir)
	}
	b, _ := json.Marshal(res)
	if string(b) != `{"applied":true,"mode":"on","voice":"af_heart:60+af_bella:40","speakMode":"always","autoSpeak":true,"restarted":true}` {
		t.Errorf("result = %s", b)
	}
	if strings.Contains(string(b), speechTestKey) || strings.Contains(string(b), "8841") {
		t.Error("the result carries the API key or the url")
	}
}

// TestSpeechApplyReportsWhatTheHarnessWillDo: voice_in has no Hermes setting,
// so autoSpeak is whatever the writer found — here off — and the result says
// both what was asked and what will happen.
func TestSpeechApplyReportsWhatTheHarnessWillDo(t *testing.T) {
	rec := &speechRecorder{}
	cfg := speechOn
	cfg.SpeakMode = "voice_in"
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), speechDeps(t, rec, cfg, false))
	res, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(speechParams), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	b, _ := json.Marshal(res)
	if !strings.Contains(string(b), `"speakMode":"voice_in","autoSpeak":false`) {
		t.Errorf("result = %s", b)
	}
}

func TestSpeechApplyDisabled(t *testing.T) {
	rec := &speechRecorder{}
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), speechDeps(t, rec, SpeechConfig{Enabled: false}, false))
	res, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(speechParams), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	b, _ := json.Marshal(res)
	if string(b) != `{"applied":true,"mode":"off","voice":null,"speakMode":null,"autoSpeak":false,"restarted":true}` {
		t.Errorf("result = %s", b)
	}
	if rec.written.Enabled {
		t.Error("wrote an enabled setting for a disabled one")
	}
}

// TestSpeechApplyRefusesUnsupportedHarness: only Hermes has a writer (an
// OpenClaw station is bridge-mode; the hub speaks for it), and the refusal
// comes before the hub is asked for a key this node could not store.
func TestSpeechApplyRefusesUnsupportedHarness(t *testing.T) {
	rec := &speechRecorder{}
	deps := speechDeps(t, rec, speechOn, true)
	deps.HarnessFor = func(string) (string, error) { return "openclaw", nil }
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), deps)
	_, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(`{"key":"openclaw:x","stationId":"s"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "openclaw") {
		t.Fatalf("err = %v, want a refusal naming the harness", err)
	}
	if len(rec.calls) != 0 {
		t.Errorf("calls = %v, want nothing fetched, written or restarted", rec.calls)
	}
}

func TestSpeechApplyBadParams(t *testing.T) {
	rec := &speechRecorder{}
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), speechDeps(t, rec, speechOn, true))
	for _, p := range []string{`{"key":"hermes:x"}`, `{"stationId":"s"}`, `nope`} {
		if _, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(p), nil); err == nil {
			t.Errorf("params %s: want an error", p)
		}
	}
	if len(rec.calls) != 0 {
		t.Errorf("calls = %v, want none", rec.calls)
	}
}

// TestSpeechApplyWithoutLifecycleWritesButDoesNotRestart: a profile sharing
// the root gateway (#273) is written, not restarted, and says so.
func TestSpeechApplyWithoutLifecycleWritesButDoesNotRestart(t *testing.T) {
	rec := &speechRecorder{}
	deps := speechDeps(t, rec, speechOn, true)
	deps.CapabilitiesFor = func(string) ([]string, error) { return []string{"health"}, nil }
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), deps)
	res, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(speechParams), nil)
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
	if strings.Contains(logs.String(), speechTestKey) {
		t.Error("the log carries the API key")
	}
}

func TestSpeechApplyRestartFailureSaysTheConfigIsWritten(t *testing.T) {
	rec := &speechRecorder{}
	deps := speechDeps(t, rec, speechOn, true)
	deps.Restart = func(string) error { return errors.New("systemctl said no") }
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), deps)
	_, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(speechParams), nil)
	if err == nil {
		t.Fatal("want an error when the restart fails")
	}
	if !strings.Contains(err.Error(), "written") || !strings.Contains(err.Error(), "systemctl said no") {
		t.Errorf("error %q should say the config IS written, and why the restart failed", err)
	}
}

func TestSpeechApplyWriteFailureDoesNotRestart(t *testing.T) {
	rec := &speechRecorder{}
	deps := speechDeps(t, rec, speechOn, true)
	deps.Write = func(string, SpeechConfig) (bool, error) {
		rec.calls = append(rec.calls, "write")
		return false, errors.New("hermes: no .env")
	}
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), deps)
	_, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(speechParams), nil)
	if err == nil || !strings.Contains(err.Error(), "no .env") {
		t.Fatalf("err = %v, want the writer's refusal", err)
	}
	if strings.Contains(strings.Join(rec.calls, ","), "restart") {
		t.Errorf("restarted after a failed write: %v", rec.calls)
	}
}

func TestSpeechApplyFetchFailure(t *testing.T) {
	rec := &speechRecorder{}
	deps := speechDeps(t, rec, speechOn, true)
	deps.Fetch = func(context.Context, string) (SpeechConfig, error) {
		return SpeechConfig{}, errors.New("hub refused (status 403)")
	}
	h := NewSpeechApplyHandler(matrixAdoptPassthrough(), deps)
	if _, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(speechParams), nil); err == nil {
		t.Fatal("want an error")
	}
	if len(rec.calls) != 0 {
		t.Errorf("calls = %v, want nothing written or restarted", rec.calls)
	}
}

func TestHTTPSpeechFetcher(t *testing.T) {
	var gotAuth, gotPath, gotMethod string
	status := http.StatusOK
	body := `{"enabled":true,"url":"http://speech:8841","apiKey":"` + speechTestKey + `","voice":"af_heart","speakMode":"voice_in"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath, gotMethod = r.Header.Get("Authorization"), r.URL.EscapedPath(), r.Method
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	fetch := NewHTTPSpeechFetcher(srv.URL+"/", "node 1", "sekret")
	cfg, err := fetch(t.Context(), "st/1")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/nodes/node%201/stations/st%2F1/speech" {
		t.Errorf("%s %s", gotMethod, gotPath)
	}
	if gotAuth != "Bearer node 1:sekret" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if cfg != (SpeechConfig{Enabled: true, URL: "http://speech:8841", APIKey: speechTestKey, Voice: "af_heart", SpeakMode: "voice_in"}) {
		t.Errorf("cfg = %+v", cfg)
	}

	// A refusal: the body is never read into the error.
	status = http.StatusForbidden
	body = `{"error":"station not hosted by this node","apiKey":"` + speechTestKey + `"}`
	_, err = fetch(t.Context(), "st/1")
	if err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "speech.apply") {
		t.Fatalf("err = %v, want a speech.apply refusal naming the status", err)
	}
	if strings.Contains(err.Error(), speechTestKey) || strings.Contains(err.Error(), "not hosted") {
		t.Errorf("error carries the response body: %q", err)
	}

	// A malformed 200: the decode error does not echo the body either.
	status = http.StatusOK
	body = `{"enabled":true,"apiKey":"` + speechTestKey + `"`
	_, err = fetch(t.Context(), "st/1")
	if err == nil {
		t.Fatal("want a decode error")
	}
	if strings.Contains(err.Error(), speechTestKey) {
		t.Errorf("error carries the key: %q", err)
	}
}
