package descriptor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

// diskFake is a rooted descriptor whose own ReadFile and ListDir do what every real descriptor's
// did before the handler guarded them: a lexical join, then an open that follows symlinks. A
// whole-file read or a listing that reaches them leaks whatever the path names.
type diskFake struct{ rootedFake }

func (d *diskFake) ReadFile(_, rel string, _ int64) ([]byte, string, bool, error) {
	b, err := os.ReadFile(filepath.Join(d.root, rel))
	return b, "", false, err
}

func (d *diskFake) ListDir(_, rel string) ([]FsEntry, error) {
	des, err := os.ReadDir(filepath.Join(d.root, rel))
	if err != nil {
		return nil, err
	}
	out := make([]FsEntry, 0, len(des))
	for _, de := range des {
		out = append(out, FsEntry{Name: de.Name(), Path: filepath.Join(rel, de.Name()), Type: "file"})
	}
	return out, nil
}

// secretTree builds a workspace holding the files a station must never serve, links that point
// at them or out of the root, and some ordinary work.
func secretTree(t *testing.T) (root string, h gateway.Handler) {
	t.Helper()
	root = t.TempDir()
	outside := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{".env", ".ssh/id_ed25519", "home/me/.ssh/id_ed25519", ".git/config", "docs/.env.local"} {
		p := filepath.Join(root, filepath.FromSlash(f))
		must(os.MkdirAll(filepath.Dir(p), 0o755))
		must(os.WriteFile(p, []byte("secret"), 0o644))
	}
	must(os.WriteFile(filepath.Join(root, "ok.txt"), []byte("fine"), 0o644))
	must(os.WriteFile(filepath.Join(root, "docs", "plan.md"), []byte("plan"), 0o644))
	must(os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0o644))
	must(os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "leak")))
	must(os.Symlink(outside, filepath.Join(root, "out")))
	must(os.Symlink(".env", filepath.Join(root, "notes.txt")))
	must(os.Symlink(".git", filepath.Join(root, "cfg")))
	reg := NewRegistry()
	reg.Register(&diskFake{rootedFake{fakeDescriptor: fakeDescriptor{harness: "fake"}, root: root}})
	return root, NewHandler(reg)
}

func fsRead(h gateway.Handler, params string) (map[string]any, error) {
	res, _, err := h.Handle(context.Background(), "fs.read", json.RawMessage(params), nil)
	if err != nil {
		return nil, err
	}
	return res.(map[string]any), nil
}

func fsList(h gateway.Handler, path string) ([]FsEntry, error) {
	res, _, err := h.Handle(context.Background(), "fs.list", json.RawMessage(fmt.Sprintf(`{"key":"fake:s1","path":%q}`, path)), nil)
	if err != nil {
		return nil, err
	}
	return res.([]FsEntry), nil
}

// A whole-file read (no offset) is the console's file browser, open to every workspace member. It
// must refuse what the offset read refuses: the denylist, links out of the root, and links that
// launder a denied path.
func TestHandlerFsReadWithoutOffsetRefusesDeniedPathsAndLinks(t *testing.T) {
	_, h := secretTree(t)
	for _, rel := range []string{".env", ".ssh/id_ed25519", "home/me/.ssh/id_ed25519", ".git/config", "docs/.env.local", "leak", "out/secret", "notes.txt", "cfg/config"} {
		m, err := fsRead(h, fmt.Sprintf(`{"key":"fake:s1","path":%q}`, rel))
		if err == nil {
			t.Errorf("%s must be refused, read %q", rel, m["content"])
			continue
		}
		if strings.Contains(err.Error(), "secret") && !strings.Contains(rel, "secret") {
			t.Errorf("%s: the error leaks content: %v", rel, err)
		}
	}
	m, err := fsRead(h, `{"key":"fake:s1","path":"docs/plan.md"}`)
	if err != nil || m["content"] != "plan" || m["encoding"] != "utf8" || m["truncated"] != false {
		t.Fatalf("an ordinary file still reads: %+v %v", m, err)
	}
}

func TestHandlerFsReadWithoutOffsetReportsTruncation(t *testing.T) {
	root, h := secretTree(t)
	if err := os.WriteFile(filepath.Join(root, "ten.txt"), []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := fsRead(h, `{"key":"fake:s1","path":"ten.txt","maxBytes":4}`)
	if err != nil || m["content"] != "0123" || m["truncated"] != true {
		t.Fatalf("a capped read: %+v %v", m, err)
	}
	m, err = fsRead(h, `{"key":"fake:s1","path":"ten.txt","maxBytes":10}`)
	if err != nil || m["content"] != "0123456789" || m["truncated"] != false {
		t.Fatalf("a read exactly at the cap is whole: %+v %v", m, err)
	}
	// The hub asks for up to 8 MiB in one read (image previews, linking a file); that is more than
	// one offset chunk, and must not come back cut at the chunk size.
	big := make([]byte, MaxChunk+1024)
	if err := os.WriteFile(filepath.Join(root, "big.bin"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	m, err = fsRead(h, fmt.Sprintf(`{"key":"fake:s1","path":"big.bin","maxBytes":%d}`, 8<<20))
	if err != nil || m["truncated"] != false || m["encoding"] != "utf8" || len(m["content"].(string)) != len(big) {
		t.Fatalf("a read past one chunk: truncated=%v len=%d err=%v", m["truncated"], len(fmt.Sprint(m["content"])), err)
	}
}

func TestHandlerFsListRefusesDeniedFoldersAndHidesDeniedEntries(t *testing.T) {
	_, h := secretTree(t)
	for _, rel := range []string{".ssh", "home/me/.ssh", ".git", "cfg", "out", "/"} {
		if entries, err := fsList(h, rel); err == nil {
			t.Errorf("listing %s must be refused, got %+v", rel, entries)
		}
	}
	names := func(path string) []string {
		t.Helper()
		entries, err := fsList(h, path)
		if err != nil {
			t.Fatalf("listing %s: %v", path, err)
		}
		var out []string
		for _, e := range entries {
			out = append(out, e.Name)
		}
		return out
	}
	root := strings.Join(names("."), ",")
	for _, hidden := range []string{".env", ".ssh", ".git"} {
		if strings.Contains(","+root+",", ","+hidden+",") {
			t.Errorf("the root listing shows %s: %s", hidden, root)
		}
	}
	if !strings.Contains(root, "ok.txt") || !strings.Contains(root, "docs") {
		t.Errorf("the root listing still shows the work: %s", root)
	}
	if docs := strings.Join(names("docs"), ","); docs != "plan.md" {
		t.Errorf("a nested listing hides .env.local: %s", docs)
	}
	if entries, _ := fsList(h, "docs"); len(entries) != 1 || entries[0].Path != "docs/plan.md" || entries[0].Type != "file" || entries[0].Size == nil {
		t.Errorf("an entry keeps its path, type and size: %+v", entries)
	}
}

// The node's denylist and the hub's (packages/contract/src/paths.ts) read the same vectors.
func TestDeniedMatchesTheContractVectors(t *testing.T) {
	b, err := os.ReadFile("../../../../packages/contract/fixtures/denied-paths-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Cases []struct {
			Path string  `json:"path"`
			Rule *string `json:"rule"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) < 40 {
		t.Fatalf("only %d vectors", len(v.Cases))
	}
	for _, c := range v.Cases {
		rule, denied := Denied(c.Path)
		switch {
		case c.Rule == nil && denied:
			t.Errorf("%q is ordinary but denied by %s", c.Path, rule)
		case c.Rule != nil && (!denied || rule != *c.Rule):
			t.Errorf("%q: want rule %q, got %q (denied=%v)", c.Path, *c.Rule, rule, denied)
		}
	}
}

func TestGuardedReadNeedsAWorkspaceRooter(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})
	h := NewHandler(reg)
	if _, err := fsRead(h, `{"key":"fake:s1","path":"file.txt"}`); err == nil {
		t.Error("a descriptor that names no root has no guarded read")
	}
	if _, err := fsList(h, "."); err == nil {
		t.Error("a descriptor that names no root has no guarded listing")
	}
	if _, _, err := GuardedReadFile(&fakeDescriptor{harness: "fake"}, "fake:s1", "file.txt", 10); !errors.Is(err, ErrNoWorkspaceRoot) {
		t.Errorf("GuardedReadFile: %v", err)
	}
}
