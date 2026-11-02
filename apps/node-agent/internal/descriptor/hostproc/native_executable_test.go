package hostproc

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A harness binary is often a script whose interpreter sits beside it — `pi`
// and `pi-acp` are Node programs in the same directory as `node`. A node-agent
// started by launchd or systemd inherits a PATH that does not contain it, so
// the version probe ran the script, the kernel could not find the interpreter,
// and readiness reported "Selected Pi engine or pi-acp package version is
// unavailable" — a version refusal for what was really an environment one.
//
// The discovery probe already prepends the engine's own directory
// (piACPDiscoverSkills). This pins the same for the version probe, so the two
// cannot disagree about whether a harness is runnable.
func TestNativeExecutableVersionFindsAnInterpreterBesideTheBinary(t *testing.T) {
	dir := t.TempDir()
	interpreter := filepath.Join(dir, "agentpod-test-interp")
	if err := os.WriteFile(interpreter, []byte("#!/bin/sh\necho 9.9.9\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	harness := filepath.Join(dir, "agentpod-test-harness")
	if err := os.WriteFile(harness, []byte("#!/usr/bin/env agentpod-test-interp\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	// A PATH that deliberately excludes the directory holding the interpreter.
	t.Setenv("PATH", "/usr/bin:/bin")
	if got := NativeExecutableVersion(context.Background(), harness); got != "9.9.9" {
		t.Fatalf("version probe could not run a binary whose interpreter sits beside it: %q", got)
	}
}

// OpenCode and Hermes resolved their executables with a bare exec.LookPath
// while every other resolution in this package goes through binaryLocator,
// which already knows the directories harnesses install into. A node started
// by launchd or systemd inherits a PATH without /opt/homebrew/bin, so OpenCode
// was refused as "unresolved" on a machine where it was plainly installed, and
// Hermes resolved only because /usr/local/bin happens to sit on the default
// PATH -- luck, not design.
func TestNativeHarnessBinaryResolvesOutsidePath(t *testing.T) {
	home := t.TempDir()
	brew := filepath.Join(home, "opt", "homebrew", "bin")
	if err := os.MkdirAll(brew, 0o700); err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(brew, "agentpod-test-harness")
	if err := os.WriteFile(installed, []byte("#!/bin/sh\necho 1.2.3\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	// A PATH that finds nothing, as a service-started node's would be.
	absent := func(string) (string, error) { return "", exec.ErrNotFound }
	locator := BinaryLocator{
		UserHome:     home,
		LookPath:     absent,
		IsExecutable: IsExecutableFile,
		PreferDirs:   []string{brew},
	}
	got, ok := locator.Locate("agentpod-test-harness", "")
	if !ok || got != installed {
		t.Fatalf("locator did not resolve a harness outside PATH: %q ok=%v", got, ok)
	}
	// And the bare form this replaces cannot.
	if _, err := absent("agentpod-test-harness"); err == nil {
		t.Fatal("expected the bare PATH lookup to fail, making the point moot")
	}
}
