package gateway

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func gitIdentityPassthrough() Handler {
	return HandlerFunc(func(_ context.Context, verb string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		return "inner:" + verb, false, nil
	})
}

func TestGitIdentityHandlerPassesOtherVerbsThrough(t *testing.T) {
	h := NewGitIdentityHandler(gitIdentityPassthrough(), t.TempDir())
	got, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if got != "inner:health" {
		t.Errorf("got %v, want the inner handler's result", got)
	}
}

func TestGitIdentityHandlerPreservesTerminalFrames(t *testing.T) {
	inner := &frameRecorder{}
	h := NewGitIdentityHandler(inner, t.TempDir())

	fh, ok := h.(FrameHandler)
	if !ok {
		t.Fatal("gitIdentityHandler must implement FrameHandler so it cannot drop terminal input")
	}
	raw := json.RawMessage(`{"type":"input","id":"attach-1","data":"aGk="}`)
	if err := fh.HandleFrame("input", "attach-1", raw); err != nil {
		t.Fatalf("HandleFrame: %v", err)
	}
	if inner.gotType != "input" || inner.gotID != "attach-1" {
		t.Fatalf("inner frame = %q:%q, want input:attach-1", inner.gotType, inner.gotID)
	}
}

// The hub asks twice — once to provision, once when an operator re-runs it — and must get the
// SAME key back. A second key would leave the one registered on forge orphaned: pushes keep
// working until somebody revokes what they think is the live key.
func TestGitIdentityEnsureIsIdempotent(t *testing.T) {
	root := t.TempDir()
	h := NewGitIdentityHandler(gitIdentityPassthrough(), root)
	params := json.RawMessage(`{"stationId":"stn_abc","stationKey":"hermes:press"}`)

	first, _, err := h.Handle(t.Context(), "git.identity.ensure", params, nil)
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	firstMap, ok := first.(map[string]any)
	if !ok {
		t.Fatalf("result = %T, want a map", first)
	}
	pub, _ := firstMap["publicKey"].(string)
	if !strings.HasPrefix(pub, "ssh-ed25519 ") {
		t.Errorf("publicKey = %q, want an ssh-ed25519 key", pub)
	}
	if firstMap["created"] != true {
		t.Errorf("created = %v on first ensure, want true", firstMap["created"])
	}

	second, _, err := h.Handle(t.Context(), "git.identity.ensure", params, nil)
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	secondMap := second.(map[string]any)
	if secondMap["publicKey"] != pub {
		t.Errorf("second ensure returned a different key:\n %v\n %v", secondMap["publicKey"], pub)
	}
	if secondMap["created"] != false {
		t.Errorf("created = %v on second ensure, want false", secondMap["created"])
	}
}

// The private half is the one thing on the node worth stealing. It must not ride back in a
// response the hub logs.
func TestGitIdentityEnsureKeepsThePrivateKeyOnTheNode(t *testing.T) {
	root := t.TempDir()
	h := NewGitIdentityHandler(gitIdentityPassthrough(), root)

	res, _, err := h.Handle(t.Context(), "git.identity.ensure", json.RawMessage(`{"stationId":"stn_abc","stationKey":"hermes:press"}`), nil)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	encoded, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(encoded), "PRIVATE KEY") {
		t.Fatal("the response carried private key material")
	}
	if strings.Contains(string(encoded), root) {
		t.Errorf("the response leaked the on-disk key path: %s", encoded)
	}

	priv := filepath.Join(root, "git-identities", "stn_abc")
	info, statErr := os.Stat(priv)
	if statErr != nil {
		t.Fatalf("private key not on the node: %v", statErr)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("private key mode = %o, want 600", perm)
	}
}

func TestGitIdentityEnsureRejectsAMissingStation(t *testing.T) {
	h := NewGitIdentityHandler(gitIdentityPassthrough(), t.TempDir())
	if _, _, err := h.Handle(t.Context(), "git.identity.ensure", json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("want an error when stationId is absent")
	}
}

// A key recorded under no station key is a key the spawn path will never find, so the push it was
// provisioned for fails with nothing anywhere to explain why.
func TestGitIdentityEnsureRequiresTheStationKey(t *testing.T) {
	root := t.TempDir()
	h := NewGitIdentityHandler(gitIdentityPassthrough(), root)
	if _, _, err := h.Handle(t.Context(), "git.identity.ensure", json.RawMessage(`{"stationId":"stn_abc"}`), nil); err == nil {
		t.Fatal("want an error when stationKey is absent")
	}
	// And nothing is left behind by the refusal.
	if _, statErr := os.Stat(filepath.Join(root, "git-identities", "stn_abc")); !os.IsNotExist(statErr) {
		t.Error("a refused ensure minted a key anyway")
	}
}

// `EnsureKey` is idempotent, so a key file left behind after a station is reassigned would be
// handed to the NEXT agent and registered against their account.
func TestGitIdentityRemoveDeletesTheKey(t *testing.T) {
	root := t.TempDir()
	h := NewGitIdentityHandler(gitIdentityPassthrough(), root)
	params := json.RawMessage(`{"stationId":"stn_abc","stationKey":"hermes:press"}`)

	first, _, err := h.Handle(t.Context(), "git.identity.ensure", params, nil)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if _, _, err := h.Handle(t.Context(), "git.identity.remove", params, nil); err != nil {
		t.Fatalf("remove: %v", err)
	}
	for _, p := range []string{"stn_abc", "stn_abc.pub"} {
		if _, statErr := os.Stat(filepath.Join(root, "git-identities", p)); !os.IsNotExist(statErr) {
			t.Errorf("%s still present after remove (%v)", p, statErr)
		}
	}

	// A fresh ensure must mint a NEW key, not resurrect the removed one.
	again, _, err := h.Handle(t.Context(), "git.identity.ensure", params, nil)
	if err != nil {
		t.Fatalf("ensure after remove: %v", err)
	}
	if again.(map[string]any)["publicKey"] == first.(map[string]any)["publicKey"] {
		t.Error("ensure after remove returned the removed key")
	}
	if again.(map[string]any)["created"] != true {
		t.Error("created = false after remove, want a freshly minted key")
	}
}

// Removing a key a station never had is the ordinary state of a withdrawal retried after a
// half-finished one. It must not fail.
func TestGitIdentityRemoveIsIdempotent(t *testing.T) {
	h := NewGitIdentityHandler(gitIdentityPassthrough(), t.TempDir())
	if _, _, err := h.Handle(t.Context(), "git.identity.remove", json.RawMessage(`{"stationId":"stn_none","stationKey":"hermes:gone"}`), nil); err != nil {
		t.Fatalf("remove of an absent key: %v", err)
	}
}
