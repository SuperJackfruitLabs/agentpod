package hermes

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

func TestHermesRootAndProfileKeepHarnessFilesPrivate(t *testing.T) {
	home := filepath.Join(t.TempDir(), ".hermes")
	writeTree(t, home, "config.yaml", "profile.yaml", "logs/gateway.log", "sessions/s1.json", "state.db", "kanban.db",
		"profiles/kai/config.yaml", "profiles/kai/notes.md", "notes.md")
	writeTree(t, filepath.Join(home, "profiles", "kai"), "logs/agent.log", "sessions/s2.json", "state.db", "docs/plan.md", "memories/m.md")
	reg := descriptor.NewRegistry()
	reg.Register(NewHermes(home))

	res, err := handle(t, reg, "fs.walk", `{"key":"hermes","path":"."}`)
	if err != nil {
		t.Fatal(err)
	}
	if got := filePaths(res.(descriptor.WalkResult)); len(got) != 1 || got[0] != "notes.md" {
		t.Fatalf("root lists only the user's files: %v", got)
	}
	res, err = handle(t, reg, "fs.walk", `{"key":"hermes:kai","path":"."}`)
	if err != nil {
		t.Fatal(err)
	}
	if got := filePaths(res.(descriptor.WalkResult)); len(got) != 2 || got[0] != "docs/plan.md" || got[1] != "notes.md" {
		t.Fatalf("profile lists only the user's files: %v", got)
	}
	for _, c := range [][2]string{
		{"hermes", "config.yaml"}, {"hermes", "logs/gateway.log"}, {"hermes", "profiles/kai/notes.md"}, {"hermes", "kanban.db"},
		{"hermes:kai", "sessions/s2.json"}, {"hermes:kai", "state.db"}, {"hermes:kai", "memories/m.md"},
	} {
		if _, err := handle(t, reg, "fs.read", fmt.Sprintf(`{"key":%q,"path":%q,"offset":0}`, c[0], c[1])); !errors.Is(err, descriptor.ErrDenied) {
			t.Errorf("%v must be refused as private: %v", c, err)
		}
	}
	if _, err := handle(t, reg, "fs.read", `{"key":"hermes:kai","path":"docs/plan.md","offset":0}`); err != nil {
		t.Errorf("an ordinary file still reads: %v", err)
	}
	if _, err := handle(t, reg, "fs.walk", `{"key":"hermes","path":"profiles"}`); !errors.Is(err, descriptor.ErrDenied) {
		t.Errorf("walking a private folder is refused: %v", err)
	}
}

// The console's file browser reads without an offset and lists folders, for every workspace
// member. A profile's .env holds its model keys and Matrix password, so neither may reach it.
func TestHermesFileBrowserNeverServesTheProfileSecrets(t *testing.T) {
	home := filepath.Join(t.TempDir(), ".hermes")
	writeTree(t, filepath.Join(home, "profiles", "kai"), ".env", "auth.json", "config.yaml", ".ssh/id_ed25519", "docs/plan.md", "SOUL.md")
	reg := descriptor.NewRegistry()
	reg.Register(NewHermes(home))

	for _, p := range []string{".env", "auth.json", "config.yaml", ".ssh/id_ed25519"} {
		if _, err := handle(t, reg, "fs.read", fmt.Sprintf(`{"key":"hermes:kai","path":%q}`, p)); !errors.Is(err, descriptor.ErrDenied) {
			t.Errorf("a whole-file read of %s must be refused: %v", p, err)
		}
	}
	if _, err := handle(t, reg, "fs.list", `{"key":"hermes:kai","path":".ssh"}`); !errors.Is(err, descriptor.ErrDenied) {
		t.Errorf("listing .ssh must be refused: %v", err)
	}
	res, err := handle(t, reg, "fs.list", `{"key":"hermes:kai","path":"."}`)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range res.([]descriptor.FsEntry) {
		names = append(names, e.Name)
	}
	if got := fmt.Sprint(names); got != "[SOUL.md docs]" {
		t.Errorf("the profile lists only the user's files: %s", got)
	}
	if _, err := handle(t, reg, "fs.read", `{"key":"hermes:kai","path":"SOUL.md"}`); err != nil {
		t.Errorf("an ordinary file still reads: %v", err)
	}
}
