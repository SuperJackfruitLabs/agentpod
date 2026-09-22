package descriptor

import (
	"context"
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

// Every exec of a harness binary needs the harness's own directory on PATH,
// not just the version probe.
//
// `pi`, `pi-acp` and `openclaw` are Node programs whose interpreter sits beside
// them. #540 fixed the version probe by prepending that directory; the harness
// REPORT commands were left running with the service environment, so readiness
// passed on a harness whose inventory then failed with
// `exit status 127: env: node: No such file or directory`. One helper now
// serves both, so the two cannot drift apart again.
func TestHarnessCommandPutsTheBinarysDirectoryOnPath(t *testing.T) {
	dir := t.TempDir()
	interpreter := filepath.Join(dir, "agentpod-test-interp")
	if err := os.WriteFile(interpreter, []byte("#!/bin/sh\necho reported\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	harness := filepath.Join(dir, "agentpod-test-report")
	if err := os.WriteFile(harness, []byte("#!/usr/bin/env agentpod-test-interp\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "/usr/bin:/bin")

	cmd := harnessCommand(context.Background(), harness, "skills", "list")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("a harness report could not find its interpreter: %v", err)
	}
	if strings.TrimSpace(string(out)) != "reported" {
		t.Fatalf("unexpected output %q", out)
	}
	// The binary's directory must come FIRST, so a same-named binary earlier
	// on the service PATH cannot answer for this one.
	var path string
	for _, kv := range cmd.Env {
		if strings.HasPrefix(kv, "PATH=") {
			path = strings.TrimPrefix(kv, "PATH=")
		}
	}
	if !strings.HasPrefix(path, dir+string(os.PathListSeparator)) {
		t.Fatalf("PATH does not lead with the binary's directory: %q", path)
	}
}
