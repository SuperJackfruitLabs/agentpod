package descriptor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func writeTree(t *testing.T, root string, files ...string) {
	t.Helper()
	for _, f := range files {
		p := filepath.Join(root, filepath.FromSlash(f))
		mustOK(t, os.MkdirAll(filepath.Dir(p), 0o755))
		mustOK(t, os.WriteFile(p, []byte("x"), 0o644))
	}
}

func handle(t *testing.T, reg *Registry, verb, params string) (any, error) {
	t.Helper()
	res, _, err := NewHandler(reg).Handle(context.Background(), verb, json.RawMessage(params), nil)
	return res, err
}

type failingRooter struct{ fakeDescriptor }

func (failingRooter) WorkspaceRoot(string) (string, error) {
	return "", errors.New("open /home/someone/.hermes/profiles/x: boom")
}

func TestWorkspaceRootErrorsCarryNoHostPath(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&failingRooter{fakeDescriptor{harness: "fake"}})
	for verb, params := range map[string]string{
		"fs.walk": `{"key":"fake:s1","path":"."}`,
		"fs.read": `{"key":"fake:s1","path":"a","offset":0}`,
	} {
		_, err := handle(t, reg, verb, params)
		if err == nil || strings.Contains(err.Error(), "/home/") {
			t.Errorf("%s: want a path-free error, got %v", verb, err)
		}
	}
}

func TestReadAtErrorsCarryNoHostPath(t *testing.T) {
	root := t.TempDir()
	_, _, _, err := ReadAt(root, "missing.txt", 0, 10)
	if err == nil || strings.Contains(err.Error(), root) || strings.Contains(err.Error(), os.TempDir()) {
		t.Fatalf("want a path-free error, got %v", err)
	}
	_, _, _, err = ReadAt(root, "../escape", 0, 10)
	if err == nil || strings.Contains(err.Error(), root) {
		t.Fatalf("escape error leaks: %v", err)
	}
}

func TestReadAtOfAFifoDoesNotBlock(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o644); err != nil {
		t.Skip("no mkfifo here")
	}
	done := make(chan error, 1)
	go func() { _, _, _, err := ReadAt(root, "pipe", 0, 10); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a FIFO is not a regular file")
		}
	case <-timeAfter():
		t.Fatal("ReadAt blocked on a FIFO")
	}
}

func TestWalkSaysWhichLimitStoppedIt(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 5; i++ {
		mustOK(t, os.WriteFile(filepath.Join(root, fmt.Sprintf("f%d", i)), make([]byte, 10), 0o644))
	}
	if got, _ := Walk(root, ".", 3, 1<<20); got.TruncatedBy != "files" || !got.TooMany {
		t.Fatalf("files: %+v", got)
	}
	if got, _ := Walk(root, ".", 500, 25); got.TruncatedBy != "bytes" || !got.TooLarge {
		t.Fatalf("bytes: %+v", got)
	}
	links := t.TempDir()
	for i := 0; i < maxWalkSkipped+2; i++ {
		mustOK(t, os.Symlink("/nonexistent", filepath.Join(links, fmt.Sprintf("l%04d", i))))
	}
	if got, _ := Walk(links, ".", 500, 1<<20); got.TruncatedBy != "skipped" {
		t.Fatalf("skipped: %+v", got)
	}
	if got, _ := Walk(root, ".", 500, 1<<20); got.TruncatedBy != "" || got.TooMany || got.TooLarge {
		t.Fatalf("a complete walk says nothing: %+v", got)
	}
}

func TestDeniedCoversGhTokenAndShellHistory(t *testing.T) {
	for _, p := range []string{".config/gh/hosts.yml", "home/.config/gh/hosts.yml", ".bash_history", "u/.zsh_history",
		".python_history", ".node_repl_history", ".psql_history", ".mysql_history"} {
		if _, ok := Denied(p); !ok {
			t.Errorf("%s must be denied", p)
		}
	}
	for _, p := range []string{".config/gh/config.yml", "docs/history.md", ".config/other/hosts.yml"} {
		if rule, ok := Denied(p); ok {
			t.Errorf("%s is ordinary but denied by %s", p, rule)
		}
	}
}

func timeAfter() <-chan time.Time { return time.After(3 * time.Second) }

func TestPrivateNamesAreJudgedByTheRequestedAndTheResolvedName(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, "config.yaml", "ok.txt")
	mustOK(t, os.Symlink(filepath.Join(root, "config.yaml"), filepath.Join(root, "notes.txt"))) // ordinary name, private target
	mustOK(t, os.Symlink(filepath.Join(root, "ok.txt"), filepath.Join(root, "sessions")))       // private name, ordinary target
	private := []string{"config.yaml", "sessions"}
	for _, rel := range []string{"notes.txt", "sessions", "config.yaml"} {
		if _, _, _, err := ReadAt(root, rel, 0, 10, private...); !errors.Is(err, ErrDenied) {
			t.Errorf("ReadAt %s must be refused: %v", rel, err)
		}
		if _, err := Walk(root, rel, 500, 1<<20, private...); !errors.Is(err, ErrDenied) {
			t.Errorf("Walk %s must be refused: %v", rel, err)
		}
	}
	if _, _, _, err := ReadAt(root, "ok.txt", 0, 10, private...); err != nil {
		t.Errorf("an ordinary file still reads: %v", err)
	}
}
