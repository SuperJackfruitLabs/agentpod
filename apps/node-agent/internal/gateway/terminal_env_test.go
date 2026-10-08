package gateway

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/terminal"
)

// term.open asks envFn for the station's environment by its key, and the shell gets it.
func TestTermOpenGivesTheShellTheStationsEnv(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	workspace := t.TempDir()
	mgr := terminal.NewManager()
	t.Cleanup(mgr.Shutdown)
	resolver := WorkspaceFunc(func(string) (string, error) { return workspace, nil })
	var askedFor string
	envFn := func(key string) []string {
		askedFor = key
		return []string{"GIT_AUTHOR_NAME=Fixture Agent"}
	}
	h := NewTerminalHandlerWithEnv(gitIdentityPassthrough(), resolver, mgr, envFn)

	res, _, err := h.Handle(context.Background(), "term.open", json.RawMessage(`{"key":"hermes:press","cols":80,"rows":24}`), nil)
	if err != nil {
		t.Fatalf("term.open: %v", err)
	}
	if askedFor != "hermes:press" {
		t.Errorf("envFn asked for %q, want the station key", askedFor)
	}
	id := res.(map[string]any)["sessionId"].(string)
	sess, ok := mgr.Get(id)
	if !ok {
		t.Fatal("no session")
	}
	ch, unsub := sess.Subscribe()
	defer unsub()
	if err := sess.Write([]byte("echo \"author=[$GIT_AUTHOR_NAME]\"\n")); err != nil {
		t.Fatal(err)
	}
	var acc strings.Builder
	deadline := time.After(3 * time.Second)
	for !strings.Contains(acc.String(), "author=[Fixture Agent]") {
		select {
		case chunk := <-ch:
			acc.Write(chunk)
		case <-deadline:
			t.Fatalf("the shell did not get the station's env; output %q", acc.String())
		}
	}
}
