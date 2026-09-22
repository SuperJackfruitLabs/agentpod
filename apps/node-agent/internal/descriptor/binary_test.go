package descriptor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A harness CLI installed with `npm i -g` under a node version manager lands in
// that node's own bin directory, not in any fixed path. OpenClaw installs
// exactly this way -- `~/.nvm/versions/node/v22.14.0/bin/openclaw` -- so it was
// unresolvable to a node-agent whose service PATH lacks that directory, and
// readiness reported "Selected OpenClaw executable is unresolved" for a harness
// that was installed and on the operator's own PATH.
func TestWellKnownBinaryDirsIncludeNodeVersionManagerBins(t *testing.T) {
	home := t.TempDir()
	for _, version := range []string{"v18.20.0", "v22.14.0", "v20.11.1"} {
		if err := os.MkdirAll(filepath.Join(home, ".nvm", "versions", "node", version, "bin"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	dirs := wellKnownBinaryDirs(home)

	var nvm []string
	for _, dir := range dirs {
		if strings.Contains(dir, ".nvm") {
			nvm = append(nvm, dir)
		}
	}
	if len(nvm) != 3 {
		t.Fatalf("every installed node version should be probed, got %v", nvm)
	}
	// Newest first: an old version left behind by an upgrade must not shadow
	// the CLI the operator actually uses.
	want := []string{
		filepath.Join(home, ".nvm", "versions", "node", "v22.14.0", "bin"),
		filepath.Join(home, ".nvm", "versions", "node", "v20.11.1", "bin"),
		filepath.Join(home, ".nvm", "versions", "node", "v18.20.0", "bin"),
	}
	for i := range want {
		if nvm[i] != want[i] {
			t.Errorf("nvm dir %d = %q, want %q (newest first)", i, nvm[i], want[i])
		}
	}
	// A home with no version manager yields no such entries and does not fail.
	if got := wellKnownBinaryDirs(t.TempDir()); len(got) == 0 {
		t.Error("a home without nvm should still yield the fixed directories")
	}
	// And "" still omits every home-relative candidate.
	for _, dir := range wellKnownBinaryDirs("") {
		if !filepath.IsAbs(dir) || strings.Contains(dir, ".nvm") {
			t.Errorf("unknown home produced %q", dir)
		}
	}
}
