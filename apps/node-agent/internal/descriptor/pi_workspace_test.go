package descriptor

import (
	"os"
	"path/filepath"
	"testing"
)

// The workspace station (issue #286).
//
// Pi derives stations from EXISTING sessions, so a machine where Pi has never
// run reported none at all: a freshly provisioned Pi runtime reached `online`
// with zero stations, and every station-scoped route — Chat, Files, Terminal —
// needs a station id. Measured live 2026-08-13 on Modal:
// GET /api/nodes/<id>/stations → [].
//
// The fix is additive: the descriptor reports the node's workspace directory as
// a station in its own right, and discovered sessions are added to that rather
// than being the only source. These tests pin both halves — the new station,
// and the fleet's existing session stations surviving unchanged beside it.

// piNodeWithWorkspace returns a descriptor for a node whose workspace directory
// exists, with `installed` naming the executables this node has (nil = none).
//
// The host seams are stubbed for the same reason stubPiHost exists: binary
// resolution ends in wellKnownBinaryDirs, which probes /opt/homebrew/bin
// whatever PATH says, so a developer machine with a real Pi install would make
// the "no Pi here" cases pass for the wrong reason. workspaceDir is set
// directly rather than through the environment so the case never depends on
// whether the machine running it happens to have a /workspace.
func piNodeWithWorkspace(t *testing.T, dataDir string, installed map[string]string) (*piDescriptor, string) {
	t.Helper()
	ws := t.TempDir()
	p := stubPiHost(t, NewPi(dataDir), installed)
	p.workspaceDir = ws
	return p, ws
}

// piInstalled is the "Pi is on this node, the adapter is not" host: enough for
// a usable station, not enough for the Chat tab.
var piInstalled = map[string]string{"pi": "/usr/bin/pi"}

// piAndAdapterInstalled is the host where BOTH halves of the chat path resolve.
var piAndAdapterInstalled = map[string]string{
	"pi":            "/usr/bin/pi",
	piACPBinaryName: "/usr/bin/pi-acp",
}

// A machine where Pi has NEVER run — no data dir, no sessions — must still
// yield one usable station. "Usable" is not "listed": the key has to resolve
// back to the workspace for the fs and health verbs, or the console shows a
// station whose every tab errors.
func TestPiDetectReportsWorkspaceStationOnAFreshMachine(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "agent") // deliberately never created
	p, ws := piNodeWithWorkspace(t, dataDir, piInstalled)

	stations, err := p.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(stations) != 1 {
		t.Fatalf("want 1 workspace station on a machine with no sessions, got %d: %+v", len(stations), stations)
	}
	s := stations[0]
	if s.Key != piProjectKey(ws) {
		t.Errorf("key = %q, want the standard pi:<hash-of-path> key %q", s.Key, piProjectKey(ws))
	}
	if s.Harness != "pi" || s.Kind != "leaf" {
		t.Errorf("harness/kind = %q/%q, want pi/leaf", s.Harness, s.Kind)
	}
	if s.WorkspacePath == nil || *s.WorkspacePath != ws {
		t.Errorf("workspace = %v, want %s", s.WorkspacePath, ws)
	}
	if s.DisplayName != filepath.Base(ws) {
		t.Errorf("displayName = %q, want %q", s.DisplayName, filepath.Base(ws))
	}

	for _, want := range []string{"health", "logs", "fs.read", "fs.write", "terminal", "cleanup"} {
		if !hasCapability(s.Capabilities, want) {
			t.Errorf("capability %q missing: %v", want, s.Capabilities)
		}
	}

	// The station must actually work. Files first — that is the tab a user
	// opens when the runtime has just been provisioned and is empty.
	if err := os.WriteFile(filepath.Join(ws, "hello.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := p.ListDir(s.Key, ".")
	if err != nil {
		t.Fatalf("ListDir on the workspace station: %v", err)
	}
	if len(entries) != 1 || entries[0].Name != "hello.txt" {
		t.Errorf("ListDir = %+v, want the workspace's own contents", entries)
	}
	if _, err := p.Health(s.Key); err != nil {
		t.Errorf("Health on the workspace station: %v", err)
	}
}

// The fleet regression guard. On a host where Pi HAS been used, every station
// its sessions produce must still be reported, with the key it already has —
// adoption state is keyed on it, so a renamed or vanished station is lost
// adoption state on a live fleet host.
func TestPiDetectWorkspaceStationDoesNotReplaceSessionStations(t *testing.T) {
	dataDir, wsHyphen := buildPiFixture(t)
	p, ws := piNodeWithWorkspace(t, dataDir, piInstalled)

	stations, err := p.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	keys := make(map[string]string, len(stations))
	for _, s := range stations {
		if s.WorkspacePath == nil {
			t.Fatalf("station %q has no workspace path", s.Key)
		}
		keys[s.Key] = *s.WorkspacePath
	}
	if got := keys[piProjectKey(wsHyphen)]; got != wsHyphen {
		t.Errorf("session-derived station for %s is gone (workspace=%q); it must survive the workspace station", wsHyphen, got)
	}
	if got := keys[piProjectKey(ws)]; got != ws {
		t.Errorf("workspace station for %s missing (workspace=%q)", ws, got)
	}
	if len(stations) != 2 {
		t.Errorf("want exactly the session station + the workspace station, got %d: %+v", len(stations), stations)
	}
}

// Once someone chats in the workspace, Pi writes a session whose cwd IS the
// workspace. That must not double the station: same path, same key, one
// station — which is also what keeps the station's identity (and its adoption
// state) stable across the transition from empty to used.
func TestPiDetectWorkspaceStationDedupesAgainstItsOwnSession(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "agent")
	ws := filepath.Join(root, "workspace")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	writePiSession(t, dataDir, "--workspace--", ws)

	p := stubPiHost(t, NewPi(dataDir), piInstalled)
	p.workspaceDir = ws

	stations, err := p.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(stations) != 1 {
		t.Fatalf("want 1 station for one workspace, got %d: %+v", len(stations), stations)
	}
	if stations[0].Key != piProjectKey(ws) {
		t.Errorf("key = %q, want %q — the key must not churn once sessions appear", stations[0].Key, piProjectKey(ws))
	}
}

// Every node-agent registers every descriptor, and every provisioned image has
// a /workspace — including the OpenCode ones. A workspace station on a node
// with no Pi would be a station whose Chat, Health and Terminal have nothing to
// run, so the station rides on Pi actually being installed here.
func TestPiDetectNoWorkspaceStationWithoutPiInstalled(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "agent")
	p, _ := piNodeWithWorkspace(t, dataDir, nil)

	stations, err := p.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(stations) != 0 {
		t.Errorf("a node without Pi must report no Pi stations, got %+v", stations)
	}
}

// A fleet host has no workspace directory at all — nothing is invented for it.
func TestPiDetectNoWorkspaceStationWhenTheDirectoryIsAbsent(t *testing.T) {
	dataDir, wsHyphen := buildPiFixture(t)
	p := stubPiHost(t, NewPi(dataDir), piInstalled)
	p.workspaceDir = filepath.Join(t.TempDir(), "absent")

	stations, err := p.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(stations) != 1 || stations[0].Key != piProjectKey(wsHyphen) {
		t.Errorf("want only the session-derived station, got %+v", stations)
	}
}

// The workspace station obeys the SAME acp rule as every other Pi station: the
// console gates the Chat tab on this capability alone, so advertising it with
// only half the chain resolved buys a tab that dies on its first prompt (the
// 2026-08-12 live failure). Both binaries, or no capability.
func TestPiWorkspaceStationACPRequiresBothBinaries(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "agent")

	p, _ := piNodeWithWorkspace(t, dataDir, piInstalled)
	stations, err := p.Detect()
	if err != nil {
		t.Fatal(err)
	}
	if len(stations) != 1 {
		t.Fatalf("want the workspace station, got %+v", stations)
	}
	if hasCapability(stations[0].Capabilities, "acp") {
		t.Error("acp must not be advertised on the workspace station without the pi-acp adapter")
	}

	adapterOnly, _ := piNodeWithWorkspace(t, dataDir, map[string]string{piACPBinaryName: "/usr/bin/pi-acp"})
	stations, err = adapterOnly.Detect()
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range stations {
		if hasCapability(s.Capabilities, "acp") {
			t.Error("acp must not be advertised when `pi` itself cannot be resolved: pi-acp would have nothing to drive")
		}
	}

	both, ws := piNodeWithWorkspace(t, dataDir, piAndAdapterInstalled)
	stations, err = both.Detect()
	if err != nil {
		t.Fatal(err)
	}
	if len(stations) != 1 {
		t.Fatalf("want the workspace station, got %+v", stations)
	}
	if !hasCapability(stations[0].Capabilities, "acp") {
		t.Error("acp must be advertised on the workspace station when both binaries resolve")
	}
	// And the chat path must actually resolve the key, in the workspace.
	_, dir, _, err := both.ACPCommand(stations[0].Key)
	if err != nil {
		t.Fatalf("ACPCommand on the workspace station: %v", err)
	}
	if dir != ws {
		t.Errorf("ACPCommand dir = %q, want the workspace %q", dir, ws)
	}
}

// Pi has no persistent process to stop or start, so this descriptor implements
// no Lifecycle at all. A workspace station that advertised it would offer the
// console Stop/Start buttons wired to nothing.
func TestPiWorkspaceStationNeverAdvertisesLifecycle(t *testing.T) {
	dataDir, _ := buildPiFixture(t)
	p, _ := piNodeWithWorkspace(t, dataDir, piAndAdapterInstalled)

	stations, err := p.Detect()
	if err != nil {
		t.Fatal(err)
	}
	if len(stations) == 0 {
		t.Fatal("no stations to check")
	}
	for _, s := range stations {
		if hasCapability(s.Capabilities, "lifecycle") {
			t.Errorf("station %q advertises lifecycle; Pi has no process to stop or start: %v", s.Key, s.Capabilities)
		}
	}
	if _, ok := Descriptor(p).(Lifecycle); ok {
		t.Error("piDescriptor must not implement Lifecycle")
	}
}

// Where the workspace directory comes from: the provisioned convention
// (/workspace on Docker, Fly and Modal alike), overridable by environment for
// a host that mounts it elsewhere.
func TestNewPiResolvesWorkspaceDir(t *testing.T) {
	t.Setenv(piWorkspaceEnv, "")
	if got := NewPi(t.TempDir()).(*piDescriptor).workspaceDir; got != piDefaultWorkspaceDir {
		t.Errorf("workspaceDir = %q, want the default %q", got, piDefaultWorkspaceDir)
	}

	t.Setenv(piWorkspaceEnv, "/mnt/data/workspace")
	if got := NewPi(t.TempDir()).(*piDescriptor).workspaceDir; got != "/mnt/data/workspace" {
		t.Errorf("workspaceDir = %q, want the %s override", got, piWorkspaceEnv)
	}
}
