package service

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandForFindsSystemctlOutsidePATHAndSuppliesRuntimeDir(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	run := t.TempDir()
	if err := os.Mkdir(filepath.Join(run, "1001"), 0o700); err != nil {
		t.Fatal(err)
	}
	oldDirs, oldRun := systemBinDirs, runtimeDirRoot
	systemBinDirs, runtimeDirRoot = []string{bin}, run
	t.Cleanup(func() { systemBinDirs, runtimeDirRoot = oldDirs, oldRun })
	noPath := func(string) (string, error) { return "", errors.New("not on PATH") }
	cmd := commandFor("systemctl", []string{"--user", "is-active", "agentpod-node"}, noPath, func(string) string { return "" }, os.Stat, 1001)
	if cmd.Path != filepath.Join(bin, "systemctl") {
		t.Fatalf("systemctl not resolved outside PATH: %q", cmd.Path)
	}
	want := "XDG_RUNTIME_DIR=" + filepath.Join(run, "1001")
	found := false
	for _, e := range cmd.Env {
		found = found || e == want
	}
	if !found {
		t.Fatalf("user manager unreachable: env lacks %s", want)
	}
	kept := commandFor("systemctl", []string{"--user", "status"}, noPath, func(string) string { return "/custom" }, os.Stat, 1001)
	if kept.Env != nil {
		t.Fatal("an existing XDG_RUNTIME_DIR was overridden")
	}
}

func TestUserUnitPutsUserHarnessesOnPATH(t *testing.T) {
	if !strings.Contains(systemdUserUnitTemplate, "Environment=PATH=%h/.local/bin:%h/.local/node/bin:") {
		t.Fatal("user unit PATH does not reach ~/.local/bin and its Node")
	}
}
