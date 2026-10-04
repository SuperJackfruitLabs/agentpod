package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/otelenv"
)

func telemetryFixture(t *testing.T) (*fakeManager, string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "otel.env")
	return &fakeManager{otelPath: p}, p
}

func noProbe(t *testing.T) probeFunc {
	return func(string) (int, error) { t.Fatal("probe must not be called"); return 0, nil }
}

func TestTelemetryEnableWritesAndRestarts(t *testing.T) {
	mgr, p := telemetryFixture(t)
	var buf bytes.Buffer
	code := telemetryCmd(mgr, []string{"enable", "--endpoint", "http://collector:4318"}, &buf, noProbe(t))
	if code != 0 {
		t.Fatalf("code %d, out %s", code, buf.String())
	}
	st, _ := otelenv.Read(p)
	if !st.Enabled || st.Endpoint != "http://collector:4318" {
		t.Errorf("state %+v", st)
	}
	if !mgr.restartCalled {
		t.Error("expected restart")
	}
}

func TestTelemetryEnableUnchangedDoesNotRestart(t *testing.T) {
	mgr, p := telemetryFixture(t)
	if _, err := otelenv.SetEndpoint(p, "http://collector:4318"); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	code := telemetryCmd(mgr, []string{"enable", "--endpoint", "http://collector:4318"}, &buf, noProbe(t))
	if code != 0 || mgr.restartCalled {
		t.Errorf("code %d restart %v", code, mgr.restartCalled)
	}
	if !strings.Contains(buf.String(), "unchanged") {
		t.Errorf("out %q", buf.String())
	}
}

func TestTelemetryEnableInvalidEndpointLeavesFileAlone(t *testing.T) {
	mgr, p := telemetryFixture(t)
	for _, ep := range []string{"", "ftp://x", "http://x\nFOO=bar", "http://a=b"} {
		var buf bytes.Buffer
		args := []string{"enable"}
		if ep != "" {
			args = append(args, "--endpoint", ep)
		}
		if code := telemetryCmd(mgr, args, &buf, noProbe(t)); code == 0 {
			t.Errorf("endpoint %q: want non-zero", ep)
		}
	}
	if _, err := os.Stat(p); err == nil {
		t.Error("file must not exist after refused enables")
	}
	if mgr.restartCalled {
		t.Error("no restart on refusal")
	}
}

func TestTelemetryEnableRestartFailureHintsAndFails(t *testing.T) {
	mgr, _ := telemetryFixture(t)
	mgr.restartErr = errors.New("boom")
	var buf bytes.Buffer
	code := telemetryCmd(mgr, []string{"enable", "--endpoint", "https://c.example"}, &buf, noProbe(t))
	if code == 0 {
		t.Error("want non-zero")
	}
	if !strings.Contains(buf.String(), "fake restart hint") || !strings.Contains(buf.String(), "boom") {
		t.Errorf("out %q", buf.String())
	}
}

func TestTelemetryDisable(t *testing.T) {
	mgr, p := telemetryFixture(t)
	if _, err := otelenv.SetEndpoint(p, "http://c:4318"); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if code := telemetryCmd(mgr, []string{"disable"}, &buf, noProbe(t)); code != 0 {
		t.Fatalf("code %d %s", code, buf.String())
	}
	if st, _ := otelenv.Read(p); st.Enabled {
		t.Error("still enabled")
	}
	if !mgr.restartCalled {
		t.Error("expected restart")
	}
	// second disable: unchanged, no restart
	mgr.restartCalled = false
	buf.Reset()
	if code := telemetryCmd(mgr, []string{"disable"}, &buf, noProbe(t)); code != 0 || mgr.restartCalled {
		t.Errorf("code %d restart %v", code, mgr.restartCalled)
	}
}

func TestTelemetryDisableRestartFailure(t *testing.T) {
	mgr, p := telemetryFixture(t)
	_, _ = otelenv.SetEndpoint(p, "http://c:4318")
	mgr.restartErr = errors.New("boom")
	var buf bytes.Buffer
	if code := telemetryCmd(mgr, []string{"disable"}, &buf, noProbe(t)); code == 0 {
		t.Error("want non-zero")
	}
	if !strings.Contains(buf.String(), "fake restart hint") {
		t.Errorf("out %q", buf.String())
	}
}

func TestTelemetryUnsupportedOnMacOS(t *testing.T) {
	mgr := &fakeManager{otelPathErr: otelenv.ErrUnsupported}
	for _, args := range [][]string{{"status"}, {"enable", "--endpoint", "http://c"}, {"disable"}} {
		var buf bytes.Buffer
		if code := telemetryCmd(mgr, args, &buf, noProbe(t)); code == 0 {
			t.Errorf("%v: want non-zero", args)
		}
		if !strings.Contains(buf.String(), "unsupported on macOS") {
			t.Errorf("%v: out %q", args, buf.String())
		}
	}
	if mgr.restartCalled {
		t.Error("no restart")
	}
}

func TestTelemetryStatusDisabledDoesNotProbe(t *testing.T) {
	mgr, p := telemetryFixture(t)
	var buf bytes.Buffer
	if code := telemetryCmd(mgr, []string{"status"}, &buf, noProbe(t)); code != 0 {
		t.Fatalf("code %d", code)
	}
	if !strings.Contains(buf.String(), p) || !strings.Contains(buf.String(), "disabled") {
		t.Errorf("out %q", buf.String())
	}
}

func TestTelemetryStatusEnabledProbes(t *testing.T) {
	mgr, p := telemetryFixture(t)
	_, _ = otelenv.SetEndpoint(p, "http://c:4318/")
	var gotEp string
	probe := func(ep string) (int, error) { gotEp = ep; return 405, nil }
	var buf bytes.Buffer
	if code := telemetryCmd(mgr, []string{"status"}, &buf, probe); code != 0 {
		t.Fatalf("code %d", code)
	}
	if gotEp != "http://c:4318" {
		t.Errorf("probe endpoint %q", gotEp)
	}
	if !strings.Contains(buf.String(), "answers") || !strings.Contains(buf.String(), "405") {
		t.Errorf("out %q", buf.String())
	}

	buf.Reset()
	telemetryCmd(mgr, []string{"status"}, &buf, func(string) (int, error) { return 0, errors.New("refused") })
	if !strings.Contains(buf.String(), "not answering") {
		t.Errorf("out %q", buf.String())
	}
}

func TestTelemetryStatusJSON(t *testing.T) {
	mgr, p := telemetryFixture(t)
	_, _ = otelenv.SetEndpoint(p, "http://c:4318")
	var buf bytes.Buffer
	telemetryCmd(mgr, []string{"status", "--json"}, &buf, func(string) (int, error) { return 200, nil })
	var got struct {
		Path     string `json:"path"`
		Endpoint string `json:"endpoint"`
		Enabled  bool   `json:"enabled"`
		Probe    *struct {
			Answers bool `json:"answers"`
			Status  int  `json:"status"`
		} `json:"probe"`
	}
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("%v: %s", err, buf.String())
	}
	if got.Path != p || got.Endpoint != "http://c:4318" || !got.Enabled || got.Probe == nil || !got.Probe.Answers || got.Probe.Status != 200 {
		t.Errorf("got %+v", got)
	}

	// disabled -> no probe object
	_, _ = otelenv.Disable(p)
	buf.Reset()
	telemetryCmd(mgr, []string{"status", "--json"}, &buf, noProbe(t))
	if strings.Contains(buf.String(), `"probe"`) {
		t.Errorf("disabled JSON must omit probe: %s", buf.String())
	}
}

func TestTelemetryUsage(t *testing.T) {
	mgr, _ := telemetryFixture(t)
	var buf bytes.Buffer
	if code := telemetryCmd(mgr, nil, &buf, noProbe(t)); code != 2 {
		t.Errorf("no verb: code %d", code)
	}
	buf.Reset()
	if code := telemetryCmd(mgr, []string{"bogus"}, &buf, noProbe(t)); code != 2 {
		t.Errorf("bogus: code %d", code)
	}
	buf.Reset()
	if code := telemetryCmd(mgr, []string{"-h"}, &buf, noProbe(t)); code != 0 || !strings.Contains(buf.String(), "apn telemetry") {
		t.Errorf("-h: code %d out %q", code, buf.String())
	}
}

func TestHTTPProbe(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.WriteHeader(http.StatusMethodNotAllowed)
	}))
	code, err := httpProbe(time.Second)(srv.URL + "/")
	if err != nil || code != 405 || path != "/v1/traces" {
		t.Errorf("code %d err %v path %q", code, err, path)
	}
	srv.Close()
	if _, err := httpProbe(time.Second)(srv.URL); err == nil {
		t.Error("closed server must error")
	}

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
	}))
	defer slow.Close()
	if _, err := httpProbe(50 * time.Millisecond)(slow.URL); err == nil {
		t.Error("timeout must error")
	}
}

func TestApplyEnrollOTLP(t *testing.T) {
	mgr, p := telemetryFixture(t)
	var buf bytes.Buffer
	if !applyEnrollOTLP(mgr, "http://c:4318", &buf) {
		t.Fatalf("failed: %s", buf.String())
	}
	if st, _ := otelenv.Read(p); !st.Enabled || st.Endpoint != "http://c:4318" {
		t.Errorf("state %+v", st)
	}
	if mgr.restartCalled {
		t.Error("enroll must not restart")
	}

	// empty endpoint is a no-op
	mgr2, p2 := telemetryFixture(t)
	applyEnrollOTLP(mgr2, "", &buf)
	if _, err := os.Stat(p2); err == nil {
		t.Error("empty endpoint wrote a file")
	}
}

func TestApplyEnrollOTLPMacOSWarnsAndContinues(t *testing.T) {
	mgr := &fakeManager{otelPathErr: otelenv.ErrUnsupported}
	var buf bytes.Buffer
	if !applyEnrollOTLP(mgr, "http://c:4318", &buf) {
		t.Error("macOS must not fail enrollment")
	}
	if !strings.Contains(buf.String(), "warning") || !strings.Contains(buf.String(), "macOS") {
		t.Errorf("out %q", buf.String())
	}
}

func TestHelpRegistersTelemetry(t *testing.T) {
	if !isCommand("telemetry") {
		t.Error("telemetry not registered")
	}
	if !strings.Contains(commandHelp("enroll"), "--otlp-endpoint") {
		t.Error("enroll help missing --otlp-endpoint")
	}
}
