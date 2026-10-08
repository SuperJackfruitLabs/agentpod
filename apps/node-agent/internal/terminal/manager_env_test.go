package terminal_test

import (
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/terminal"
)

// A terminal is where an operator or agent runs git by hand. It must commit as the same author
// the harness does, so the env given at open has to reach the shell.
func TestOpenWithEnvReachesTheShell(t *testing.T) {
	m := terminal.NewManager()
	defer m.Shutdown()
	s, err := m.OpenWithEnv("station-1", "/bin/sh", t.TempDir(), 80, 24, []string{"GIT_AUTHOR_NAME=Fixture Agent"})
	if err != nil {
		t.Fatal(err)
	}
	ch, unsub := s.Subscribe()
	defer unsub()
	if err := s.Write([]byte("echo \"author=[$GIT_AUTHOR_NAME]\"\n")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ch, "author=[Fixture Agent]")
}
