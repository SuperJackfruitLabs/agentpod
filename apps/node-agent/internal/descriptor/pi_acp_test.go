package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	stub := filepath.Join(bin, piACPBinaryName)
	for _, name := range []string{piACPBinaryName, "pi"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	return stub
}

// stubPiHost replaces a descriptor's host seams so a case can state exactly
// what this node has installed. installed maps an executable name to the path
// PATH would report for it; anything absent is not installed anywhere — the
// well-known dirs included, which is the whole point. /opt/homebrew/bin/pi and
// /opt/homebrew/bin/pi-acp both exist on the machine this bug was found on, and
// wellKnownBinaryDirs probes that directory whatever PATH says, so a case about
// a MISSING binary cannot be written against the real host at all.
func stubPiHost(t *testing.T, d Descriptor, installed map[string]string) *piDescriptor {
	t.Helper()
	p, ok := d.(*piDescriptor)
	if !ok {
		t.Fatalf("expected *piDescriptor, got %T", d)
	}
	p.userHome = testStubHome
	p.lookPath = func(name string) (string, error) {
		if path, ok := installed[name]; ok {
			return path, nil
		}
		return "", fmt.Errorf("%s: not found in $PATH", name)
	}
	p.isExecutable = func(string) bool { return false }
	p.getenv = func(name string) string {
		if name == "PATH" {
			return testStubPath
		}
		return ""
	}
	return p
}

// The Chat tab is gated on the "acp" capability alone, so advertising it
// without the adapter installed buys a tab that fails the moment it is clicked.
// No adapter must mean no capability — and an error that names what is missing.
func TestPiACPCapabilityGatedOnAdapter(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	// Nothing installed → no acp capability, and a clear error rather than a
	// Chat tab that fails when clicked.
	stations, err := stubPiHost(t, NewPi(dataDir), nil).Detect()
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
	_, _, _, err = stubPiHost(t, NewPi(dataDir), nil).ACPCommand(piProjectKey(ws))
	if err == nil {
		t.Fatal("ACPCommand should error when the adapter is absent")
	}
	if !strings.Contains(err.Error(), piACPBinaryName) {
		t.Errorf("error %q should name %q so the console message is actionable", err, piACPBinaryName)
	}
}

// The other half of the gate, and the one the fleet paid for: the adapter is
// installed but Pi is not reachable. pi-acp exists only to spawn `pi --mode
// rpc`, so advertising "acp" here promises a Chat tab that can only close on
// its first prompt — precisely the failure the gate exists to prevent. Half a
// chain verified is a capability the node does not have.
func TestPiACPCapabilityGatedOnPiItself(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	installed := map[string]string{piACPBinaryName: "/opt/homebrew/bin/pi-acp"}

	stations, err := stubPiHost(t, NewPi(dataDir), installed).Detect()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range stations[0].Capabilities {
		if c == "acp" {
			t.Fatal("acp must not be advertised when `pi` itself cannot be resolved: pi-acp has nothing to drive")
		}
	}

	_, _, _, err = stubPiHost(t, NewPi(dataDir), installed).ACPCommand(piProjectKey(ws))
	if err == nil {
		t.Fatal("ACPCommand should error when `pi` cannot be found — a session that closes with no explanation is worse")
	}
	if !strings.Contains(err.Error(), piBinaryEnv) {
		t.Errorf("error %q should name %s, the operator's escape hatch", err, piBinaryEnv)
	}
}

// The adapter is spawned directly: argv[0] is the resolved pi-acp, the working
// directory is the station's workspace (the same one Files, Health and Cleanup
// use), and the only thing added to the environment is the PATH that lets the
// adapter find Pi.
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
	if len(env) != 1 {
		t.Errorf("env = %v, want exactly PATH: no credential belongs in a child env (Pi reads auth.json itself)", env)
	}
	// The stubs share a directory, so PATH's head is that directory.
	if got, ok := envValue(env, "PATH"); !ok || !strings.HasPrefix(got, filepath.Dir(stub)+string(os.PathListSeparator)) {
		t.Errorf("PATH = %q, want the directory holding pi (%q) first", got, filepath.Dir(stub))
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
	// The same host that hides the adapter from PATH hides Pi from it, and the
	// capability now requires both — so this case names both overrides.
	t.Setenv(piBinaryEnv, fakePiBinary(t))

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

// TestPiACPCommandPutsPiOnTheAdapterPath is the regression test for the live
// failure of 2026-08-12: a Pi station's Chat tab answered "ACP Connection
// Closed", the hub returned 502 in ~500ms (a spawn failure, not a timeout) and
// no acp.* row was ever written to station_audit.
//
// The node-agent ran as a macOS LaunchAgent with PATH=/usr/bin:/bin:/usr/sbin:
// /sbin. `pi-acp` lives in /opt/homebrew/bin, which the well-known-dirs probe
// finds — so the capability was advertised correctly — but `pi` lives there
// too, and /opt/homebrew/bin is not on that PATH. ACPCommand returned env=nil,
// so the adapter inherited the service's minimal PATH and could not find the
// `pi` it exists to spawn (`pi-acp` runs `pi --mode rpc` internally). It exited
// immediately.
//
// The shape reproduced here is exactly that one: pi-acp resolvable through
// PATH, `pi` reachable ONLY off it. Every earlier test put its stubs on the
// test process's own PATH, where the adapter would have found `pi` by accident
// — which is why the whole suite was green while the fleet was broken.
func TestPiACPCommandPutsPiOnTheAdapterPath(t *testing.T) {
	dataDir, ws := buildPiFixture(t)

	adapterDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(adapterDir, piACPBinaryName), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", adapterDir) // pi-acp resolves here; `pi` does NOT

	piPath := fakePiBinary(t) // <tmp>/bin/pi — off PATH, like /opt/homebrew/bin
	t.Setenv(piBinaryEnv, piPath)

	_, _, env, err := NewPi(dataDir).(ACPCommander).ACPCommand(piProjectKey(ws))
	if err != nil {
		t.Fatal(err)
	}

	piDir := filepath.Dir(piPath)
	got, ok := envValue(env, "PATH")
	if !ok {
		t.Fatalf("env = %v, want a PATH carrying %q: the adapter spawns `pi` by name", env, piDir)
	}
	if !strings.HasPrefix(got, piDir+string(os.PathListSeparator)) {
		t.Errorf("PATH = %q, want the directory holding pi (%q) FIRST", got, piDir)
	}
	if !strings.HasSuffix(got, adapterDir) {
		t.Errorf("PATH = %q must PREPEND to the inherited PATH %q, not replace it", got, adapterDir)
	}
}

func TestPiACPCommandUnknownKey(t *testing.T) {
	dataDir, _ := buildPiFixture(t)
	writePiACPStub(t)

	if _, _, _, err := NewPi(dataDir).(ACPCommander).ACPCommand("pi:deadbeef"); err == nil {
		t.Fatal("expected error for unknown station key")
	}
}
