package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// build compiles apn once per test binary and returns its path.
func build(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "apn")
	out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput()
	if err != nil {
		t.Fatalf("build failed: %v\n%s", err, out)
	}
	return bin
}

// run executes apn with a clean, isolated environment.
func run(t *testing.T, bin string, env []string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	home := t.TempDir()
	cmd.Env = append([]string{
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + home,
		"PATH=" + os.Getenv("PATH"),
	}, env...)
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("running apn: %v", err)
	}
	return string(out), code
}

// TestNodeIsAnAliasAndCannotDiverge asserts a property that lives with apn's
// own dispatch, not with the fleet split: `apn version` and `apn node
// version` are the same command because `node` is a word stripped before one
// switch — not a second dispatch that could drift. This task does not touch
// that property; it is unaffected by fleet.go moving to its own binary.
func TestNodeIsAnAliasAndCannotDiverge(t *testing.T) {
	bin := build(t)
	bare, c1 := run(t, bin, nil, "version")
	viaNode, c2 := run(t, bin, nil, "node", "version")
	if c1 != c2 || bare != viaNode {
		t.Fatalf("`apn version` and `apn node version` differ:\n%q (%d)\n%q (%d)", bare, c1, viaNode, c2)
	}
}
