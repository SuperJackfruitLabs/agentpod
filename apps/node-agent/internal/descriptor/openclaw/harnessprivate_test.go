package openclaw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

func writeTree(t *testing.T, root string, files ...string) {
	t.Helper()
	for _, f := range files {
		p := filepath.Join(root, filepath.FromSlash(f))
		mustOK(t, os.MkdirAll(filepath.Dir(p), 0o755))
		mustOK(t, os.WriteFile(p, []byte("x"), 0o644))
	}
}

func handle(t *testing.T, reg *descriptor.Registry, verb, params string) (any, error) {
	t.Helper()
	res, _, err := descriptor.NewHandler(reg).Handle(context.Background(), verb, json.RawMessage(params), nil)
	return res, err
}

func filePaths(w descriptor.WalkResult) []string {
	var out []string
	for _, f := range w.Files {
		out = append(out, f.Path)
	}
	return out
}

func TestOpenClawKeepsHarnessFilesPrivate(t *testing.T) {
	home := filepath.Join(t.TempDir(), ".openclaw")
	writeTree(t, home, "openclaw.json", "credentials/a.json", "logs/g.log", "notes.md",
		"agents/kai/agent/auth-profiles.json", "agents/kai/sessions/s.json", "agents/kai/IDENTITY.md")
	reg := descriptor.NewRegistry()
	reg.Register(NewOpenClaw(home))

	// no <home>/workspace: the root key's root is the home itself
	res, err := handle(t, reg, "fs.walk", `{"key":"openclaw","path":"."}`)
	if err != nil {
		t.Fatal(err)
	}
	if got := filePaths(res.(descriptor.WalkResult)); len(got) != 1 || got[0] != "notes.md" {
		t.Fatalf("home root lists only the user's files: %v", got)
	}
	res, err = handle(t, reg, "fs.walk", `{"key":"openclaw:kai","path":"."}`)
	if err != nil {
		t.Fatal(err)
	}
	if got := filePaths(res.(descriptor.WalkResult)); len(got) != 1 || got[0] != "IDENTITY.md" {
		t.Fatalf("agent root lists only the user's files: %v", got)
	}
	for _, c := range [][2]string{
		{"openclaw", "openclaw.json"}, {"openclaw", "credentials/a.json"}, {"openclaw", "agents/kai/IDENTITY.md"},
		{"openclaw:kai", "agent/auth-profiles.json"}, {"openclaw:kai", "sessions/s.json"},
	} {
		if _, err := handle(t, reg, "fs.read", fmt.Sprintf(`{"key":%q,"path":%q,"offset":0}`, c[0], c[1])); !errors.Is(err, descriptor.ErrDenied) {
			t.Errorf("%v must be refused as private: %v", c, err)
		}
	}
}
