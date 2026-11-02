package harnesses

import (
	"errors"
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

func TestProjectHarnessesRefuseARootThatIsTheirHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), ".claude")
	if got := descriptor.PrivateIfHome(home, nil); len(got) != 1 || got[0] != "." {
		t.Fatalf("a root inside a denied tree is wholly private: %v", got)
	}
	if got := descriptor.PrivateIfHome(t.TempDir(), nil); got != nil {
		t.Fatalf("an ordinary project is not: %v", got)
	}
	writeTree(t, home, "settings.json")
	if _, err := descriptor.Walk(home, ".", 500, 1<<20, descriptor.PrivateIfHome(home, nil)...); !errors.Is(err, descriptor.ErrDenied) {
		t.Fatalf("walking a harness home as a project is refused: %v", err)
	}
}
