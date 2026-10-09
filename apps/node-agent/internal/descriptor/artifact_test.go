package descriptor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
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

func TestReadAtRefusesAnInRootSymlinkToADeniedPath(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(root, ".env"), []byte("secret"), 0o644))
	must(os.MkdirAll(filepath.Join(root, ".git"), 0o755))
	must(os.WriteFile(filepath.Join(root, ".git", "config"), []byte("secret"), 0o644))
	must(os.WriteFile(filepath.Join(root, "real.txt"), []byte("fine"), 0o644))
	must(os.Symlink(".env", filepath.Join(root, "notes.txt")))
	must(os.Symlink(".git", filepath.Join(root, "cfg")))
	must(os.Symlink("real.txt", filepath.Join(root, "ok-link")))
	for _, rel := range []string{"notes.txt", "cfg/config"} {
		if b, _, _, err := ReadAt(root, rel, 0, 10); err == nil {
			t.Errorf("%s resolves to a denied path and must be refused, read %q", rel, b)
		}
	}
	if b, _, _, err := ReadAt(root, "ok-link", 0, 10); err != nil || string(b) != "fine" {
		t.Fatalf("a link to an ordinary file still reads: %q %v", b, err)
	}
}

func TestWalkListsFilesSkipsDeniedAndSymlinks(t *testing.T) {
	root := t.TempDir()
	site := filepath.Join(root, "site")
	mustOK(t, os.MkdirAll(filepath.Join(site, "css"), 0o755))
	mustOK(t, os.WriteFile(filepath.Join(site, "index.html"), []byte("<h1>x</h1>"), 0o644))
	mustOK(t, os.WriteFile(filepath.Join(site, "css", "a.css"), []byte("a{}"), 0o644))
	mustOK(t, os.WriteFile(filepath.Join(site, ".env"), []byte("K=V"), 0o644))
	mustOK(t, os.Symlink("/etc/hosts", filepath.Join(site, "hosts")))
	got, err := Walk(root, "site", 500, 100<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 2 || got.Files[0].Path != "css/a.css" || got.Files[1].Path != "index.html" {
		t.Fatalf("files: %+v", got.Files)
	}
	reasons := map[string]string{}
	for _, s := range got.Skipped {
		reasons[s.Path] = s.Reason
	}
	if reasons[".env"] != "denied" || reasons["hosts"] != "symlink" {
		t.Fatalf("skipped: %+v", got.Skipped)
	}
}

func TestWalkStopsAtTheCaps(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 5; i++ {
		mustOK(t, os.WriteFile(filepath.Join(root, fmt.Sprintf("f%d.txt", i)), make([]byte, 10), 0o644))
	}
	got, _ := Walk(root, ".", 3, 1<<20)
	if !got.TooMany || len(got.Files) != 3 {
		t.Fatalf("files cap: %+v", got)
	}
	got, _ = Walk(root, ".", 500, 25)
	if !got.TooLarge {
		t.Fatalf("bytes cap: %+v", got)
	}
}

func TestWalkRefusesARootOutsideTheWorkspace(t *testing.T) {
	if _, err := Walk(t.TempDir(), "..", 500, 1<<20); err == nil {
		t.Fatal("walking .. is refused")
	}
}

func TestWalkOfAFileListsItself(t *testing.T) {
	root := t.TempDir()
	mustOK(t, os.WriteFile(filepath.Join(root, "note.md"), []byte("hello"), 0o644))
	got, err := Walk(root, "note.md", 500, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 1 || got.Files[0].Path != "" || got.Files[0].Size != 5 {
		t.Fatalf("files: %+v", got.Files)
	}
}

func TestWalkRefusesADeniedRootItself(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{".ssh", ".git"} {
		mustOK(t, os.MkdirAll(filepath.Join(root, d), 0o755))
		mustOK(t, os.WriteFile(filepath.Join(root, d, "config"), []byte("x"), 0o644))
		if got, err := Walk(root, d, 500, 1<<20); err == nil || !errors.Is(err, ErrDenied) {
			t.Errorf("walking %s must be refused: %+v %v", d, got, err)
		}
	}
	mustOK(t, os.WriteFile(filepath.Join(root, ".env"), []byte("K=V"), 0o644))
	if _, err := Walk(root, ".env", 500, 1<<20); !errors.Is(err, ErrDenied) {
		t.Errorf("walking a denied file must be refused: %v", err)
	}
}

func TestWalkChecksEntriesAgainstTheFullPath(t *testing.T) {
	// "opencode" is ordinary relative to the walked folder; only joined with rel (".config") is it
	// the denied ".config/opencode", so entries must be judged by their path from the root.
	root := t.TempDir()
	dir := filepath.Join(root, ".config")
	mustOK(t, os.MkdirAll(filepath.Join(dir, "opencode"), 0o755))
	mustOK(t, os.WriteFile(filepath.Join(dir, "opencode", "k.json"), []byte("{}"), 0o644))
	mustOK(t, os.WriteFile(filepath.Join(dir, "plain.txt"), []byte("ok"), 0o644))
	got, err := Walk(root, ".config", 500, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 1 || got.Files[0].Path != "plain.txt" {
		t.Fatalf("files: %+v", got.Files)
	}
	denied := false
	for _, s := range got.Skipped {
		if s.Path == "opencode" && s.Reason == "denied" {
			denied = true
		}
	}
	if !denied {
		t.Fatalf("opencode must be skipped as denied: %+v", got.Skipped)
	}
}

func TestWalkNeverListsASymlinkWhateverItsTarget(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	mustOK(t, os.WriteFile(filepath.Join(outside, "o.txt"), []byte("o"), 0o644))
	mustOK(t, os.WriteFile(filepath.Join(root, ".env"), []byte("K=V"), 0o644))
	mustOK(t, os.MkdirAll(filepath.Join(root, ".git"), 0o755))
	mustOK(t, os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref"), 0o644))
	site := filepath.Join(root, "site")
	mustOK(t, os.MkdirAll(site, 0o755))
	mustOK(t, os.WriteFile(filepath.Join(site, "ok.txt"), []byte("ok"), 0o644))
	mustOK(t, os.Symlink(filepath.Join(root, ".env"), filepath.Join(site, "notes.txt")))   // in-root, denied target
	mustOK(t, os.Symlink(filepath.Join(root, ".git"), filepath.Join(site, "cfg")))         // in-root dir, denied
	mustOK(t, os.Symlink(filepath.Join(outside, "o.txt"), filepath.Join(site, "out.txt"))) // outside the root
	mustOK(t, os.Symlink(filepath.Join(site, "ok.txt"), filepath.Join(site, "alias.txt"))) // in-root, fine target
	got, err := Walk(root, "site", 500, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 1 || got.Files[0].Path != "ok.txt" {
		t.Fatalf("only the real file is listed: %+v", got.Files)
	}
	for _, n := range []string{"notes.txt", "cfg", "out.txt", "alias.txt"} {
		found := false
		for _, s := range got.Skipped {
			if s.Path == n && s.Reason == "symlink" {
				found = true
			}
		}
		if !found {
			t.Errorf("%s must be skipped as symlink: %+v", n, got.Skipped)
		}
	}
}

func TestWalkRefusesARootThatIsASymlinkToADeniedPath(t *testing.T) {
	root := t.TempDir()
	mustOK(t, os.MkdirAll(filepath.Join(root, ".git"), 0o755))
	mustOK(t, os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref"), 0o644))
	mustOK(t, os.Symlink(filepath.Join(root, ".git"), filepath.Join(root, "docs")))
	if got, err := Walk(root, "docs", 500, 1<<20); !errors.Is(err, ErrDenied) {
		t.Fatalf("a link to a denied tree is refused: %+v %v", got, err)
	}
}

func TestHandlerFsWalk(t *testing.T) {
	root := t.TempDir()
	mustOK(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("abc"), 0o644))
	reg := NewRegistry()
	reg.Register(&rootedFake{fakeDescriptor: fakeDescriptor{harness: "fake"}, root: root})
	h := NewHandler(reg)
	res, _, err := h.Handle(context.Background(), "fs.walk", json.RawMessage(`{"key":"fake:s1","path":"."}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	w := res.(WalkResult)
	if len(w.Files) != 1 || w.Files[0].Path != "a.txt" || w.Root != "." {
		t.Fatalf("unexpected %+v", w)
	}
	reg2 := NewRegistry()
	reg2.Register(&fakeDescriptor{harness: "fake"})
	if _, _, err := NewHandler(reg2).Handle(context.Background(), "fs.walk", json.RawMessage(`{"key":"fake:s1","path":"."}`), nil); err == nil {
		t.Fatal("a descriptor without WorkspaceRooter refuses fs.walk")
	}
}

func TestWalkJudgesEntriesByTheRequestedAndTheResolvedPath(t *testing.T) {
	root := t.TempDir()
	// requested path denied, resolved path ordinary: .config -> cfg
	mustOK(t, os.MkdirAll(filepath.Join(root, "cfg", "opencode"), 0o755))
	mustOK(t, os.WriteFile(filepath.Join(root, "cfg", "opencode", "k.json"), []byte("{}"), 0o644))
	mustOK(t, os.WriteFile(filepath.Join(root, "cfg", "plain.txt"), []byte("ok"), 0o644))
	mustOK(t, os.Symlink(filepath.Join(root, "cfg"), filepath.Join(root, ".config")))
	// requested path ordinary, resolved path denied: docs -> real/.config
	mustOK(t, os.MkdirAll(filepath.Join(root, "real", ".config", "opencode"), 0o755))
	mustOK(t, os.WriteFile(filepath.Join(root, "real", ".config", "opencode", "k.json"), []byte("{}"), 0o644))
	mustOK(t, os.WriteFile(filepath.Join(root, "real", ".config", "plain.txt"), []byte("ok"), 0o644))
	mustOK(t, os.Symlink(filepath.Join(root, "real", ".config"), filepath.Join(root, "docs")))
	for _, rel := range []string{".config", "docs"} {
		got, err := Walk(root, rel, 500, 1<<20)
		if err != nil {
			t.Fatalf("%s: %v", rel, err)
		}
		if len(got.Files) != 1 || got.Files[0].Path != "plain.txt" {
			t.Errorf("%s: files %+v", rel, got.Files)
		}
	}
}

func TestWalkOfAFileIsJudgedByItsRequestedAndResolvedName(t *testing.T) {
	root := t.TempDir()
	mustOK(t, os.WriteFile(filepath.Join(root, ".env"), []byte("K=V"), 0o644))
	mustOK(t, os.WriteFile(filepath.Join(root, "ok.txt"), []byte("ok"), 0o644))
	mustOK(t, os.Symlink(filepath.Join(root, ".env"), filepath.Join(root, "notes.txt")))  // ordinary name, denied target
	mustOK(t, os.Symlink(filepath.Join(root, "ok.txt"), filepath.Join(root, ".env.bak"))) // denied name, ordinary target
	for _, rel := range []string{"notes.txt", ".env.bak"} {
		if got, err := Walk(root, rel, 500, 1<<20); !errors.Is(err, ErrDenied) {
			t.Errorf("%s must be refused: %+v %v", rel, got, err)
		}
	}
}

func TestWalkSkipsAWholeDeniedFolderAsOneEntry(t *testing.T) {
	root := t.TempDir()
	site := filepath.Join(root, "site")
	mustOK(t, os.MkdirAll(filepath.Join(site, ".git", "objects", "ab"), 0o755))
	mustOK(t, os.WriteFile(filepath.Join(site, ".git", "HEAD"), []byte("ref"), 0o644))
	mustOK(t, os.WriteFile(filepath.Join(site, ".git", "objects", "ab", "cd"), []byte("o"), 0o644))
	mustOK(t, os.MkdirAll(filepath.Join(site, ".ssh"), 0o755))
	mustOK(t, os.WriteFile(filepath.Join(site, ".ssh", "id_rsa"), []byte("k"), 0o644))
	mustOK(t, os.WriteFile(filepath.Join(site, "index.html"), []byte("x"), 0o644))
	got, err := Walk(root, "site", 500, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 1 || got.Files[0].Path != "index.html" {
		t.Fatalf("files: %+v", got.Files)
	}
	if len(got.Skipped) != 2 || got.Skipped[0] != (WalkSkip{".git", "denied"}) || got.Skipped[1] != (WalkSkip{".ssh", "denied"}) {
		t.Fatalf("each denied folder is one skipped entry and nothing beneath it: %+v", got.Skipped)
	}
}

func TestWalkBoundsTheSkippedList(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < maxWalkSkipped+5; i++ {
		mustOK(t, os.Symlink("/nonexistent", filepath.Join(root, fmt.Sprintf("l%04d", i))))
	}
	got, err := Walk(root, ".", 500, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Skipped) != maxWalkSkipped || !got.TooMany {
		t.Fatalf("skipped %d tooMany=%v", len(got.Skipped), got.TooMany)
	}
}

func TestWalkBoundsTheEntriesVisited(t *testing.T) {
	root := t.TempDir()
	// Plain folders are neither files nor skipped; only the visit cap bounds them.
	for i := 0; i < maxWalkEntries+5; i++ {
		mustOK(t, os.Mkdir(filepath.Join(root, fmt.Sprintf("d%05d", i)), 0o755))
	}
	got, err := Walk(root, ".", 500, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if !got.TooMany {
		t.Fatalf("the visit cap must set tooMany: files=%d", len(got.Files))
	}
}

func TestWalkSurvivesAnUnreadableFolder(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root reads everything")
	}
	root := t.TempDir()
	mustOK(t, os.MkdirAll(filepath.Join(root, "a", "locked"), 0o755))
	mustOK(t, os.WriteFile(filepath.Join(root, "a", "ok.txt"), []byte("ok"), 0o644))
	mustOK(t, os.Chmod(filepath.Join(root, "a", "locked"), 0))
	defer os.Chmod(filepath.Join(root, "a", "locked"), 0o755)
	got, err := Walk(root, "a", 500, 1<<20)
	if err != nil {
		t.Fatalf("one unreadable folder must not abort the walk: %v", err)
	}
	if len(got.Files) != 1 || got.Files[0].Path != "ok.txt" || len(got.Skipped) != 1 || got.Skipped[0] != (WalkSkip{"locked", "unreadable"}) {
		t.Fatalf("got %+v", got)
	}
}

func TestWalkErrorsCarryNoHostPath(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"missing", "../escape"} {
		_, err := Walk(root, rel, 500, 1<<20)
		if err == nil {
			t.Fatalf("%s must fail", rel)
		}
		if strings.Contains(err.Error(), root) || strings.Contains(err.Error(), os.TempDir()) {
			t.Errorf("%s: error leaks a host path: %v", rel, err)
		}
	}
}

func TestWalkOfAnUnreadableRootCarriesNoHostPath(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root reads everything")
	}
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	mustOK(t, os.Mkdir(locked, 0o755))
	mustOK(t, os.Chmod(locked, 0))
	defer os.Chmod(locked, 0o755)
	_, err := Walk(root, "locked", 500, 1<<20)
	if err == nil || strings.Contains(err.Error(), root) {
		t.Fatalf("want an error without the host path, got %v", err)
	}
}

func mustOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
