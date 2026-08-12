package descriptor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writePiACPStub drops an executable named pi-acp into a fresh directory and
// makes that directory the whole of PATH. It returns the stub's path.
func writePiACPStub(t *testing.T) string {
	t.Helper()
	bin := t.TempDir()
	stub := filepath.Join(bin, piACPBinaryName)
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	return stub
}

// The Chat tab is gated on the "acp" capability alone, so advertising it
// without the adapter installed buys a tab that fails the moment it is clicked.
// No adapter must mean no capability — and an error that names what is missing.
func TestPiACPCapabilityGatedOnAdapter(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	// No adapter on PATH → no acp capability, and a clear error rather than a
	// Chat tab that fails when clicked.
	t.Setenv("PATH", t.TempDir())
	t.Setenv(piACPBinaryEnv, "")
	stations, err := NewPi(dataDir).Detect()
	if err != nil {
		t.Fatal(err)
	}
	if len(stations) == 0 {
		t.Fatal("fixture produced no stations")
	}
	for _, c := range stations[0].Capabilities {
		if c == "acp" {
			t.Fatal("acp must not be advertised without the pi-acp adapter")
		}
	}
	_, _, _, err = NewPi(dataDir).(ACPCommander).ACPCommand(piProjectKey(ws))
	if err == nil {
		t.Fatal("ACPCommand should error when the adapter is absent")
	}
	if !strings.Contains(err.Error(), piACPBinaryName) {
		t.Errorf("error %q should name %q so the console message is actionable", err, piACPBinaryName)
	}
}

// The adapter is spawned directly: argv[0] is the resolved pi-acp, the working
// directory is the station's workspace (the same one Files, Health and Cleanup
// use), and nothing is added to the environment.
func TestPiACPCommandUsesAdapterAndWorkspaceDir(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	stub := writePiACPStub(t)

	argv, dir, env, err := NewPi(dataDir).(ACPCommander).ACPCommand(piProjectKey(ws))
	if err != nil {
		t.Fatal(err)
	}
	if len(argv) == 0 || filepath.Base(argv[0]) != piACPBinaryName {
		t.Errorf("argv = %v, want pi-acp first", argv)
	}
	if len(argv) != 1 {
		t.Errorf("argv = %v, want exactly the adapter (it needs no arguments)", argv)
	}
	if argv[0] != stub {
		t.Errorf("argv[0] = %q, want the resolved stub %q", argv[0], stub)
	}
	if dir != ws {
		t.Errorf("dir = %q, want %q", dir, ws)
	}
	if env != nil {
		t.Errorf("env = %v, want nil", env)
	}
	// Never npx: a network fetch on the first prompt of a session is a stall
	// the operator cannot see the reason for.
	if strings.Contains(filepath.Base(argv[0]), "npx") {
		t.Errorf("argv %v must not shell out to npx on the request path", argv)
	}
}

// The npm prefix is routinely user-local (/home/openclaw/.npm-global/bin on the
// fleet host superchotu), which a service PATH commonly misses. PI_ACP_PATH is
// the escape hatch, and it is used verbatim — the operator knows their layout.
func TestPiACPCommandHonoursEnvOverride(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	t.Setenv("PATH", t.TempDir()) // nothing resolvable here
	adapter := filepath.Join(t.TempDir(), "npm-global", "bin", "pi-acp")
	t.Setenv(piACPBinaryEnv, adapter)

	stations, err := NewPi(dataDir).Detect()
	if err != nil {
		t.Fatal(err)
	}
	var advertised bool
	for _, c := range stations[0].Capabilities {
		if c == "acp" {
			advertised = true
		}
	}
	if !advertised {
		t.Errorf("acp must be advertised when %s names an adapter: %v", piACPBinaryEnv, stations[0].Capabilities)
	}

	argv, dir, _, err := NewPi(dataDir).(ACPCommander).ACPCommand(piProjectKey(ws))
	if err != nil {
		t.Fatal(err)
	}
	if len(argv) == 0 || argv[0] != adapter {
		t.Errorf("argv = %v, want the configured %q", argv, adapter)
	}
	if dir != ws {
		t.Errorf("dir = %q, want %q", dir, ws)
	}
}

func TestPiACPCommandUnknownKey(t *testing.T) {
	dataDir, _ := buildPiFixture(t)
	writePiACPStub(t)

	if _, _, _, err := NewPi(dataDir).(ACPCommander).ACPCommand("pi:deadbeef"); err == nil {
		t.Fatal("expected error for unknown station key")
	}
}
