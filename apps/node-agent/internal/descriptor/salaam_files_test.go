package descriptor

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fsops"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

// salaamFiles builds a workspace with ordinary files, a denied file, a symlink out of the
// workspace, and (optionally) the state directory inside the workspace.
func salaamFiles(t *testing.T, stateInside bool) (Descriptor, string, string) {
	t.Helper()
	base, _ := filepath.EvalSymlinks(t.TempDir())
	ws := filepath.Join(base, "workspace")
	state := filepath.Join(base, "state")
	if stateInside {
		state = filepath.Join(ws, ".salaam-state")
	}
	outside := filepath.Join(base, "outside")
	for _, d := range []string{ws, state, outside, filepath.Join(ws, "src")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p, body string) {
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(ws, "README.md"), "hello salaam\n")
	write(filepath.Join(ws, "src", "main.ts"), "export {}\n")
	write(filepath.Join(ws, ".env"), "SECRET=1\n")
	write(filepath.Join(state, "session-key"), "private\n")
	write(filepath.Join(outside, "host-secret"), "nope\n")
	if err := os.Symlink(outside, filepath.Join(ws, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "host-secret"), filepath.Join(ws, "link-out.txt")); err != nil {
		t.Fatal(err)
	}
	bin, _ := os.Executable()
	d := NewSalaamFrom(SalaamConfig{Binary: bin, StateDir: state, Workspace: ws})
	return d, salaam.StationKey(ws), base
}

func names(es []FsEntry) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.Name+":"+e.Type)
	}
	sort.Strings(out)
	return out
}

func TestSalaamListsAndReadsTheWorkspaceOnly(t *testing.T) {
	d, key, base := salaamFiles(t, false)
	root, err := d.ListDir(key, ".")
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(names(root), ",")
	if got != "README.md:file,escape:symlink,link-out.txt:symlink,src:dir" {
		t.Fatalf("workspace listing: %s", got)
	}
	sub, err := d.ListDir(key, "src")
	if err != nil || len(sub) != 1 || sub[0].Path != "src/main.ts" || sub[0].Size == nil || *sub[0].Size != 10 {
		t.Fatalf("subfolder listing: %+v %v", sub, err)
	}
	b, _, truncated, err := d.ReadFile(key, "README.md", 0)
	if err != nil || string(b) != "hello salaam\n" || truncated {
		t.Fatalf("read: %q %v %v", b, truncated, err)
	}
	b, _, truncated, err = d.ReadFile(key, "README.md", 5)
	if err != nil || string(b) != "hello" || !truncated {
		t.Fatalf("capped read: %q %v %v", b, truncated, err)
	}
	if strings.Contains(err2s(d.ReadFile(key, "nope.txt", 0)), base) {
		t.Fatal("error leaked a host path")
	}
}

func err2s(_ []byte, _ string, _ bool, err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestSalaamRefusesEscapesSymlinksDeniedAndState(t *testing.T) {
	d, key, _ := salaamFiles(t, false)
	for _, rel := range []string{"../state/session-key", "../outside/host-secret", "/etc/passwd", "link-out.txt", "escape/host-secret"} {
		if _, _, _, err := d.ReadFile(key, rel, 0); err == nil {
			t.Fatalf("read %q outside the workspace", rel)
		}
	}
	for _, rel := range []string{"..", "../state", "escape", "/"} {
		_, err := d.ListDir(key, rel)
		if err == nil {
			t.Fatalf("listed %q outside the workspace", rel)
		}
	}
	if _, err := d.ListDir(key, "../state"); !errors.Is(err, fsops.ErrEscape) {
		t.Fatalf("escape not reported as an escape: %v", err)
	}
	if _, _, _, err := d.ReadFile(key, ".env", 0); !errors.Is(err, ErrDenied) {
		t.Fatalf("denied file read: %v", err)
	}
	if _, err := d.ListDir(key, "src"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ListDir("salaam:0000000000000000", "."); err == nil {
		t.Fatal("listed a station this node does not hold")
	}
}

func TestSalaamNeverServesAStateDirectoryInsideTheWorkspace(t *testing.T) {
	d, key, _ := salaamFiles(t, true)
	root, err := d.ListDir(key, ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range root {
		if e.Name == ".salaam-state" {
			t.Fatal("state directory listed")
		}
	}
	if _, err := d.ListDir(key, ".salaam-state"); !errors.Is(err, ErrDenied) {
		t.Fatalf("state directory listable: %v", err)
	}
	if _, _, _, err := d.ReadFile(key, ".salaam-state/session-key", 0); !errors.Is(err, ErrDenied) {
		t.Fatalf("state file readable: %v", err)
	}
}
