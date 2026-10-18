package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// wireStk is the smallest stk the verbs need.
type wireStk struct {
	stkclient.Client
	mu       sync.Mutex
	opened   []string
	keyErr   error
	reload   error
	verifyRe stkclient.VerifyResult
}

func (w *wireStk) Version(context.Context) (string, error)     { return "0.0.3", nil }
func (w *wireStk) HandoverKey(context.Context) (string, error) { return "stk-handover-v1:PUB", w.keyErr }
func (w *wireStk) HandoverOpen(_ context.Context, s, _ string) error {
	w.mu.Lock()
	w.opened = append(w.opened, s)
	w.mu.Unlock()
	return nil
}
func (w *wireStk) Reload(context.Context) (stkclient.ReloadResult, error) {
	return stkclient.ReloadResult{OK: w.reload == nil}, w.reload
}
func (w *wireStk) RevokeLocal(context.Context, string) error { return nil }
func (w *wireStk) Verify(context.Context, string, string) (stkclient.VerifyResult, error) {
	return w.verifyRe, nil
}

func forgeHandler(t *testing.T) (Handler, *wireStk, string) {
	t.Helper()
	stk := &wireStk{}
	path := filepath.Join(t.TempDir(), "supertoolkit.yaml")
	svc := &forgeapi.Service{
		Ensure: func(context.Context) (forgeapi.SetupResult, error) {
			return forgeapi.SetupResult{Report: stkclient.DoctorReport{Isolation: stkclient.Isolation{Level: "separate-user"}}}, nil
		},
		NewClient:  func() stkclient.Client { return stk },
		PolicyPath: path,
	}
	return NewForgeAPIHandler(gitIdentityPassthrough(), svc), stk, path
}

// fixtures are the frames as the hub's zod schemas define them. The hub repo has no params
// fixtures, so these are hand-written from packages/contract/src/forge-api.ts and were checked
// against VERB_PARAMS with bun; testdata/forge-api-frames.json says so.
func fixtures(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	b, err := os.ReadFile("testdata/forge-api-frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Params map[string]json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f.Params
}

func asJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// The hub's fixtures decode into the node's structs and the acks have the fields the hub reads.
func TestForgeAPIVerbsAcceptTheHubsFramesAndAnswerInItsShape(t *testing.T) {
	h, stk, _ := forgeHandler(t)
	fx := fixtures(t)
	call := func(verb string) map[string]any {
		t.Helper()
		got, streamed, err := h.Handle(t.Context(), verb, fx[verb], nil)
		if err != nil || streamed {
			t.Fatalf("%s: %v (streamed %v)", verb, err, streamed)
		}
		return asJSON(t, got)
	}
	// deliver: ok:true AND stored:true AND an isolation word (the hub's three conditions).
	d := call("forge.api.deliver")
	if d["ok"] != true || d["stored"] != true || d["isolation"] != "separate-user" {
		t.Fatalf("deliver ack = %v", d)
	}
	if len(stk.opened) != 1 || stk.opened[0] != "forge-forgejo-89abcdef0123" {
		t.Fatalf("opened %v", stk.opened)
	}
	if p := call("forge.api.policy"); p["ok"] != true {
		t.Fatalf("policy ack = %v", p)
	}
	stk.verifyRe = stkclient.VerifyResult{OK: true, Login: "agent-press"}
	if v := call("forge.api.verify"); v["ok"] != true || v["login"] != "agent-press" || v["isolation"] != "separate-user" {
		t.Fatalf("verify ack = %v", v)
	}
	s := call("forge.api.status")
	grants, _ := s["grants"].([]any)
	if s["publicKey"] != "stk-handover-v1:PUB" || len(grants) != 1 {
		t.Fatalf("status ack = %v", s)
	}
	g := grants[0].(map[string]any)
	if g["grantId"] != "fag_0123456789abcdef0123456789abcdef" || g["present"] != true || g["isolation"] != "separate-user" {
		t.Fatalf("status grant = %v", g)
	}
	if r := call("forge.api.revoke"); r["removed"] != true {
		t.Fatalf("revoke ack = %v", r)
	}
	if r := call("forge.api.revoke"); r["removed"] != false {
		t.Fatalf("second revoke ack = %v", r)
	}
}

func TestForgeAPIRejectsUnknownFieldsInEveryVerb(t *testing.T) {
	h, stk, path := forgeHandler(t)
	for verb, raw := range fixtures(t) {
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		for _, extra := range []string{"token", "secret", "password", "somethingNew"} {
			m[extra] = "x"
			b, _ := json.Marshal(m)
			got, _, err := h.Handle(t.Context(), verb, b, nil)
			if err == nil || got != nil {
				t.Errorf("%s with extra %q: got %v, %v; want an error", verb, extra, got, err)
			} else if !strings.HasPrefix(err.Error(), "invalid-params:") {
				t.Errorf("%s: error %q should start with invalid-params:", verb, err)
			}
			delete(m, extra)
		}
		// A nested unknown field (inside a rule) is rejected too.
		if verb == "forge.api.deliver" {
			bad := strings.Replace(string(raw), `{ "deny":`, `{ "tokn": "x", "deny":`, 1)
			if _, _, err := h.Handle(t.Context(), verb, json.RawMessage(bad), nil); err == nil {
				t.Errorf("a rule with an unknown key was accepted")
			}
		}
	}
	if len(stk.opened) != 0 {
		t.Error("a rejected frame must reach nothing")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Error("a rejected frame must write nothing")
	}
	for _, raw := range []string{``, `null`, `[]`, `{"stationId":"s"} {"x":1}`, `{`} {
		if _, _, err := h.Handle(t.Context(), "forge.api.status", json.RawMessage(raw), nil); err == nil {
			t.Errorf("params %q accepted", raw)
		}
	}
}

func TestForgeAPIDeliverErrorAckNeverCarriesSuccess(t *testing.T) {
	h, stk, _ := forgeHandler(t)
	stk.reload = &stkclient.ReloadRejectedError{Reason: "rule user#1: bad"}
	got, _, err := h.Handle(t.Context(), "forge.api.deliver", fixtures(t)["forge.api.deliver"], nil)
	if err == nil || got != nil {
		t.Fatalf("got %v, %v; a rejected reload must be an error with no ack", got, err)
	}
	if strings.Contains(err.Error(), "c2VhbGVkLWZpeHR1cmU") {
		t.Fatalf("error carries the sealed value: %v", err)
	}
}

func TestForgeAPIStatusErrorsWhenTheKeyCannotBeRead(t *testing.T) {
	h, stk, _ := forgeHandler(t)
	stk.keyErr = errors.New("stk handover key: down")
	got, _, err := h.Handle(t.Context(), "forge.api.status", fixtures(t)["forge.api.status"], nil)
	if err == nil || got != nil {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestForgeAPIPassesOtherVerbsThroughAndForwardsFrames(t *testing.T) {
	h, _, _ := forgeHandler(t)
	got, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil || got != "inner:health" {
		t.Fatalf("got %v, %v", got, err)
	}
	inner := &frameRecorder{}
	fh, ok := NewForgeAPIHandler(inner, &forgeapi.Service{}).(FrameHandler)
	if !ok {
		t.Fatal("must implement FrameHandler so terminal input is not dropped")
	}
	if err := fh.HandleFrame("input", "attach-1", json.RawMessage(`{}`)); err != nil || inner.gotType != "input" {
		t.Fatalf("frame not forwarded: %v %q", err, inner.gotType)
	}
}
