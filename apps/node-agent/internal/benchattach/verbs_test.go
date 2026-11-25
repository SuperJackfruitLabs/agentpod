package benchattach

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchidentity"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hermes"
)

// The same bodies the contract's bench-remote.test.ts parses.
type wireFixture struct {
	Valid   map[string]json.RawMessage `json:"valid"`
	Invalid []struct {
		Verb   string          `json:"verb"`
		Why    string          `json:"why"`
		Params json.RawMessage `json:"params"`
	} `json:"invalid"`
}

func loadFixture(t *testing.T) wireFixture {
	t.Helper()
	raw, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-remote-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var f wireFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

const verbsConfig = "model:\n  default: kimi\nplugins:\n  enabled: [agentpod-live]\n"

type innerHandler struct{ called string }

func (h *innerHandler) Handle(_ context.Context, verb string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
	h.called = verb
	return "inner", false, nil
}

func newHandler(t *testing.T, harness string) (*handler, string) {
	t.Helper()
	root, profile := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte(verbsConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	installPlugin(t, profile, "0.3.0")
	keyPath := benchidentity.KeyPath(root, "st_remote1")
	_ = os.MkdirAll(filepath.Dir(keyPath), 0o700)
	_ = os.WriteFile(keyPath, []byte("placeholder"), 0o600)
	m := Manager{Root: root, KnownHosts: filepath.Join(t.TempDir(), "known_hosts"), Terminal: hermes.HermesTerminal{},
		Profile: func(string) (string, error) { return profile, nil }}
	h := NewHandler(&innerHandler{}, HandlerDeps{Root: root, Manager: m, HarnessFor: func(string) (string, error) {
		if harness == "" {
			return "", errors.New("no such station")
		}
		return harness, nil
	}}).(*handler)
	return h, profile
}

func call(t *testing.T, h *handler, verb string, params json.RawMessage) map[string]any {
	t.Helper()
	out, _, err := h.Handle(context.Background(), verb, params, nil)
	if err != nil {
		t.Fatalf("%s: %v", verb, err)
	}
	data, _ := json.Marshal(out)
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	return m
}

func TestVerbsStrictDecode(t *testing.T) {
	f := loadFixture(t)
	h, _ := newHandler(t, "hermes")
	for _, c := range f.Invalid {
		got := call(t, h, c.Verb, c.Params)
		if got["state"] != "refused" || got["code"] != CodeInvalid {
			t.Errorf("%s (%s) = %v, want refused invalid", c.Verb, c.Why, got)
		}
	}
	// Every valid body decodes into its verb's params exactly.
	for verb, into := range map[string]any{VerbEnsure: &ensureParams{}, VerbAttach: &attachParams{}, VerbDetach: &detachParams{}, VerbStatus: &statusParams{}} {
		if err := strict(f.Valid[verb], into); err != nil {
			t.Errorf("valid %s body refused: %v", verb, err)
		}
	}
	if err := strict(json.RawMessage(`{"stationId":"a"} {"stationId":"b"}`), &statusParams{}); err == nil {
		t.Error("trailing data accepted")
	}
}

func TestAttachDetachStatusThroughTheVerbs(t *testing.T) {
	f := loadFixture(t)
	h, profile := newHandler(t, "hermes")
	got := call(t, h, VerbAttach, f.Valid[VerbAttach])
	if got["state"] != "attached" || got["validBefore"] != "2099-11-25T12:48:34Z" {
		t.Fatalf("attach = %v", got)
	}
	if got := call(t, h, VerbStatus, f.Valid[VerbStatus]); got["attemptId"] != "att-1" {
		t.Fatalf("status = %v", got)
	}
	if got := call(t, h, VerbDetach, f.Valid[VerbDetach]); got["state"] != "detached" {
		t.Fatalf("detach = %v", got)
	}
	if got := call(t, h, VerbStatus, f.Valid[VerbStatus]); len(got) != 0 {
		t.Fatalf("status after detach = %v", got)
	}
	if data, _ := os.ReadFile(filepath.Join(profile, "config.yaml")); string(data) != verbsConfig {
		t.Fatalf("profile after detach = %q", data)
	}
}

func TestAttachRefusesANonHermesStation(t *testing.T) {
	f := loadFixture(t)
	for _, harness := range []string{"openclaw", ""} {
		h, _ := newHandler(t, harness)
		if got := call(t, h, VerbAttach, f.Valid[VerbAttach]); got["code"] != CodeHarnessUnsupported {
			t.Errorf("%q: attach = %v", harness, got)
		}
	}
}

func TestOtherVerbsPassThrough(t *testing.T) {
	h, _ := newHandler(t, "hermes")
	if out, _, _ := h.Handle(context.Background(), "git.identity.ensure", json.RawMessage(`{}`), nil); out != "inner" {
		t.Fatalf("passthrough = %v", out)
	}
}
