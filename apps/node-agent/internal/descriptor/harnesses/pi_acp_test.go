package harnesses

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/pi"
)

// writePiACPStub drops the two executables a Pi chat session needs — the
// pi-acp adapter and the `pi` it spawns — into a fresh directory and makes that
// directory the whole of PATH. It returns the adapter's path.
//
// Both stubs, because the "acp" capability rides on both binaries resolving:
// pi-acp is useless without a Pi to drive, which is exactly the live failure of
// 2026-08-12.
func writePiACPStub(t *testing.T) string {
	t.Helper()
	bin := t.TempDir()
	stub := filepath.Join(bin, pi.PiACPBinaryName)
	for _, name := range []string{pi.PiACPBinaryName, "pi"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	return stub
}
