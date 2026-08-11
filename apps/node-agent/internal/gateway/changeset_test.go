package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// changesetPassthrough stands in for the rest of the handler chain.
func changesetPassthrough() Handler {
	return HandlerFunc(func(_ context.Context, verb string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		return "inner:" + verb, false, nil
	})
}

func TestChangesetHandlerPassesOtherVerbsThrough(t *testing.T) {
	h := NewChangesetHandler(changesetPassthrough(), WorkspaceFunc(func(string) (string, error) {
		return "", errors.New("should not be called")
	}))
	got, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if got != "inner:health" {
		t.Errorf("got %v, want the inner handler's result", got)
	}
}

func TestChangesetStatusResolvesTheWorkspace(t *testing.T) {
	var askedFor string
	h := NewChangesetHandler(changesetPassthrough(), WorkspaceFunc(func(key string) (string, error) {
		askedFor = key
		return "", errors.New("no workspace")
	}))
	_, _, err := h.Handle(t.Context(), "changeset.status", json.RawMessage(`{"key":"codex:abc"}`), nil)
	if err == nil {
		t.Fatal("want an error when the workspace cannot be resolved")
	}
	if askedFor != "codex:abc" {
		t.Errorf("resolver asked for %q, want codex:abc", askedFor)
	}
}

func TestChangesetStatusRejectsBadParams(t *testing.T) {
	h := NewChangesetHandler(changesetPassthrough(), WorkspaceFunc(func(string) (string, error) {
		return t.TempDir(), nil
	}))
	if _, _, err := h.Handle(t.Context(), "changeset.status", json.RawMessage(`not json`), nil); err == nil {
		t.Fatal("want an error for malformed params")
	}
}

func TestChangesetDiffRequiresASide(t *testing.T) {
	h := NewChangesetHandler(changesetPassthrough(), WorkspaceFunc(func(string) (string, error) {
		return t.TempDir(), nil
	}))
	_, _, err := h.Handle(t.Context(), "changeset.diff", json.RawMessage(`{"key":"k"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "side") {
		t.Errorf("err = %v, want a message naming the missing side", err)
	}
}

func TestChangesetSaysWhenAWorkspaceIsNotARepo(t *testing.T) {
	// A distinct, readable error: the capability is meant to be gated on this,
	// so seeing it means the gate has drifted, and the message should say what
	// is actually wrong rather than surfacing raw git noise.
	dir := t.TempDir()
	h := NewChangesetHandler(changesetPassthrough(), WorkspaceFunc(func(string) (string, error) {
		return dir, nil
	}))
	_, _, err := h.Handle(t.Context(), "changeset.status", json.RawMessage(`{"key":"k"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "not a git repository") {
		t.Errorf("err = %v, want it to name the real problem", err)
	}
}

func TestChangesetRejectsAnEmptyKey(t *testing.T) {
	h := NewChangesetHandler(changesetPassthrough(), WorkspaceFunc(func(string) (string, error) {
		t.Error("resolver must not be called with an empty key")
		return "", nil
	}))
	if _, _, err := h.Handle(t.Context(), "changeset.status", json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("want an error for a missing key")
	}
}
