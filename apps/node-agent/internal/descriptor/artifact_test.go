package descriptor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadAtReadsFromOffsetAndReportsEOF(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.bin"), []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, size, eof, err := ReadAt(root, "a.bin", 4, 3)
	if err != nil || string(got) != "456" || size != 10 || eof {
		t.Fatalf("got %q size=%d eof=%v err=%v", got, size, eof, err)
	}
	got, _, eof, _ = ReadAt(root, "a.bin", 8, 3)
	if string(got) != "89" || !eof {
		t.Fatalf("tail: got %q eof=%v", got, eof)
	}
	got, _, eof, err = ReadAt(root, "a.bin", 10, 3)
	if err != nil || len(got) != 0 || !eof {
		t.Fatalf("at end: got %q eof=%v err=%v", got, eof, err)
	}
}

func TestReadAtRefusesASymlinkOutOfTheRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := ReadAt(root, "link", 0, 10); err == nil {
		t.Fatal("a symlink out of the root is refused")
	}
}

func TestReadAtRefusesParentAndDeniedPaths(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{
		"../x", ".env", "app/.env.local", "w/.env/x", "sub/.env.d/conf", ".ssh/id_ed25519", "keys/server.pem", ".git/config", "id_rsa", ".npmrc",
		".aws/credentials", ".claude/.credentials.json", ".codex/auth.json",
		".git-credentials", "h/.gemini/oauth", ".cursor/mcp.json", ".claude.json", ".config/opencode/settings.yaml",
		".local/share/opencode/log.txt", ".config/goose/config.yaml", ".docker/config.json", ".config/gcloud/x", "ENV/.ENV", ".env. ",
	} {
		// The file exists, so only the guard under test can refuse it.
		if p := filepath.Join(root, filepath.FromSlash(strings.TrimRight(rel, ". "))); !strings.Contains(rel, "..") {
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err == nil {
				_ = os.WriteFile(p, []byte("secret"), 0o644)
			}
		}
		if _, _, _, err := ReadAt(root, rel, 0, 10); err == nil {
			t.Errorf("%s must be refused", rel)
		}
	}
	// And an ordinary existing file is read, so the loop above is not refusing everything.
	if err := os.WriteFile(filepath.Join(root, "ok.txt"), []byte("fine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if b, _, _, err := ReadAt(root, "ok.txt", 0, 10); err != nil || string(b) != "fine" {
		t.Fatalf("ordinary file: %q %v", b, err)
	}
}

func TestDeniedNamesItsRule(t *testing.T) {
	if rule, ok := Denied("deploy/prod.key"); !ok || rule != "*.key" {
		t.Fatalf("got %q %v", rule, ok)
	}
	for _, ok := range []string{"docs/keys.md", "src/environment.ts", "docs/.config/readme", ".config/other", ".docker/notes.md", "gemini/notes.md"} {
		if rule, d := Denied(ok); d {
			t.Fatalf("%s is ordinary but denied by %s", ok, rule)
		}
	}
}

type rootedFake struct {
	fakeDescriptor
	root string
}

func (r *rootedFake) WorkspaceRoot(string) (string, error) { return r.root, nil }

func TestHandlerFsReadWithOffsetReturnsAChunk(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.bin"), []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := NewRegistry()
	reg.Register(&rootedFake{fakeDescriptor: fakeDescriptor{harness: "fake"}, root: root})
	h := NewHandler(reg)
	res, _, err := h.Handle(context.Background(), "fs.read", json.RawMessage(`{"key":"fake:s1","path":"a.bin","maxBytes":3,"offset":4}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	m := res.(map[string]any)
	if m["content"] != base64.StdEncoding.EncodeToString([]byte("456")) || m["encoding"] != "base64" ||
		m["offset"] != int64(4) || m["size"] != int64(10) || m["eof"] != false || m["truncated"] != true {
		t.Fatalf("unexpected result %+v", m)
	}
	if _, _, err := h.Handle(context.Background(), "fs.read", json.RawMessage(`{"key":"fake:s1","path":".env","offset":0}`), nil); err == nil {
		t.Fatal("a denied path is refused through the handler")
	}
}

func TestHandlerFsReadWithOffsetNeedsAWorkspaceRooter(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})
	h := NewHandler(reg)
	if _, _, err := h.Handle(context.Background(), "fs.read", json.RawMessage(`{"key":"fake:s1","path":"file.txt","offset":0}`), nil); err == nil {
		t.Fatal("a descriptor without WorkspaceRooter refuses offset reads")
	}
}

func TestSixDescriptorsAreWorkspaceRooters(t *testing.T) {
	for name, d := range map[string]any{
		"hermes": &hermesDescriptor{}, "claudecode": &claudeCodeDescriptor{}, "codex": &codexDescriptor{},
		"openclaw": &openclawDescriptor{}, "opencode": &openCodeDescriptor{}, "pi": &piDescriptor{},
	} {
		if _, ok := d.(WorkspaceRooter); !ok {
			t.Errorf("%s must implement WorkspaceRooter", name)
		}
	}
}
