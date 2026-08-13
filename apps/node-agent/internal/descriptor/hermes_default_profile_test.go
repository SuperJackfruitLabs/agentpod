package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Regression tests for #273.
//
// On a host where a Hermes profile IS the default gateway — i.e. the profile
// the root `hermes gateway run` (no `-p`) already serves — the node-agent
// modelled that one agent as TWO startable stations ("hermes" and
// "hermes:<name>"). Starting the profile station spawned a SECOND gateway on
// the same Matrix identity, so the agent answered every message twice. It ran
// for six weeks on molt-bot.
//
// How the default profile is identified (see hermesDescriptor.servesRootGateway):
// the Hermes home root and the profile directory resolve to the SAME Matrix
// user ID. The root gateway takes its messaging identity from the home root,
// and the default profile's directory carries a byte-identical copy of it —
// that identity match IS the duplication (two gateways syncing one account).
// Profiles with their own identity are untouched.

// defaultProfileHome builds a Hermes home shaped like the affected host:
//
//	<home>/.env                          MATRIX_USER_ID=@buddhimaan:…   (root)
//	<home>/profiles/buddhimaan/.env      MATRIX_USER_ID=@buddhimaan:…   (the default profile)
//	<home>/profiles/analyst-echo/.env    MATRIX_USER_ID=@analyst-echo:… (an ordinary profile)
//
// Both .env files also carry an access token, which must never be read.
func defaultProfileHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	writeEnv := func(dir, mxid string) {
		t.Helper()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
		body := fmt.Sprintf("MATRIX_HOMESERVER=https://id.agentpod.dev\nMATRIX_USER_ID=%s\nMATRIX_ACCESS_TOKEN=syt_SECRET_TOKEN\n", mxid)
		if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(body), 0o600); err != nil {
			t.Fatalf("write .env in %s: %v", dir, err)
		}
	}
	writeEnv(home, "@buddhimaan:id.agentpod.dev")
	writeEnv(filepath.Join(home, "profiles", "buddhimaan"), "@buddhimaan:id.agentpod.dev")
	writeEnv(filepath.Join(home, "profiles", "analyst-echo"), "@analyst-echo:id.agentpod.dev")
	return home
}

// findStation returns the station with the given key, failing the test if absent.
func findStation(t *testing.T, stations []Station, key string) Station {
	t.Helper()
	for _, s := range stations {
		if s.Key == key {
			return s
		}
	}
	t.Fatalf("station %q not found in %+v", key, stations)
	return Station{}
}

// TestHermesDetect_DefaultProfileStationDropsLifecycleCap proves the station
// modelling side of the rule: the profile that IS the root gateway is still
// listed (its files stay browsable) but no longer advertises "lifecycle", so
// the console offers no Start/Stop/Restart for it — the root "hermes" station
// is the control point for that agent.
//
// The DIRECTION THAT MUST NOT REGRESS is asserted in the same test: an ordinary
// profile keeps "lifecycle" exactly as before.
func TestHermesDetect_DefaultProfileStationDropsLifecycleCap(t *testing.T) {
	home := defaultProfileHome(t)

	stations, err := NewHermes(home).Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	root := findStation(t, stations, "hermes")
	if !slices.Contains(root.Capabilities, "lifecycle") {
		t.Errorf("root station must keep lifecycle; caps = %v", root.Capabilities)
	}
	if root.MatrixId == nil || *root.MatrixId != "@buddhimaan:id.agentpod.dev" {
		t.Errorf("root station must publish the home's matrix identity, got %v", root.MatrixId)
	}

	def := findStation(t, stations, "hermes:buddhimaan")
	if slices.Contains(def.Capabilities, "lifecycle") {
		t.Errorf("the default-gateway profile must NOT advertise lifecycle; caps = %v", def.Capabilities)
	}
	// It stays a real station: files, logs, health remain available.
	for _, want := range []string{"health", "logs", "fs.read", "terminal"} {
		if !slices.Contains(def.Capabilities, want) {
			t.Errorf("default-gateway profile lost capability %q; caps = %v", want, def.Capabilities)
		}
	}

	other := findStation(t, stations, "hermes:analyst-echo")
	if !slices.Contains(other.Capabilities, "lifecycle") {
		t.Errorf("an ordinary profile must KEEP lifecycle; caps = %v", other.Capabilities)
	}
}

// TestHermesStart_DefaultProfileRefusesToSpawnSecondGateway is the core
// regression: Start on the default-gateway profile must refuse rather than
// launch `hermes -p <name> gateway run --replace`. The guard runs BEFORE every
// launch path (systemd unit, startCmd, native fallback), so no path can spawn
// the duplicate.
func TestHermesStart_DefaultProfileRefusesToSpawnSecondGateway(t *testing.T) {
	home := defaultProfileHome(t)

	t.Run("native fallback path", func(t *testing.T) {
		dir := t.TempDir()
		hermesArgs := filepath.Join(dir, "hermes.args")
		sysdArgs := filepath.Join(dir, "systemd-run.args")
		writeRecorderStub(t, filepath.Join(dir, "hermes"), hermesArgs)
		writeRecorderStub(t, filepath.Join(dir, "systemd-run"), sysdArgs)
		t.Setenv("PATH", dir) // no systemctl → unit unknown → native fallback would fire

		lc := NewHermes(home).(Lifecycle)
		err := lc.Start("hermes:buddhimaan")
		if err == nil {
			t.Fatal("Start on the default-gateway profile must return an error, got nil")
		}
		if !strings.Contains(err.Error(), "hermes") {
			t.Errorf("error should name the station/root gateway, got %q", err)
		}
		assertNoStubRan(t, hermesArgs, sysdArgs)
	})

	t.Run("startCmd configured", func(t *testing.T) {
		dir := t.TempDir()
		marker := filepath.Join(dir, "startcmd-ran")
		writeFakeSystemctl(t, dir, false /* unit absent */)
		prependPath(t, dir)

		h := &hermesDescriptor{home: home, startCmd: "touch " + marker}
		if err := h.Start("hermes:buddhimaan"); err == nil {
			t.Fatal("Start must refuse even with a startCmd configured")
		}
		assertNoStubRan(t, marker)
	})

	t.Run("systemd unit present", func(t *testing.T) {
		dir := t.TempDir()
		sysLog := writeFakeSystemctl(t, dir, true /* unit known */)
		prependPath(t, dir)

		h := &hermesDescriptor{home: home}
		if err := h.Start("hermes:buddhimaan"); err == nil {
			t.Fatal("Start must refuse even when a per-profile unit exists")
		}
		if strings.Contains(readLog(t, sysLog), " start ") {
			t.Errorf("systemctl start must not run for the default-gateway profile; log:\n%s", readLog(t, sysLog))
		}
	})
}

// TestHermesStart_OrdinaryProfileStillStarts is the regression guarding the
// OTHER direction: a profile that is NOT the default gateway must start exactly
// as it did before — this is the behaviour real fleet hosts depend on (13
// per-profile gateways on molt-bot alone).
func TestHermesStart_OrdinaryProfileStillStarts(t *testing.T) {
	home := defaultProfileHome(t)

	dir := t.TempDir()
	argsFile := filepath.Join(dir, "hermes.args")
	writeRecorderStub(t, filepath.Join(dir, "hermes"), argsFile)
	t.Setenv("PATH", dir) // no systemd-run, no systemctl → plain detached fallback

	lc := NewHermes(home).(Lifecycle)
	if err := lc.Start("hermes:analyst-echo"); err != nil {
		t.Fatalf("Start on an ordinary profile: %v", err)
	}

	got := waitForStubArgs(t, argsFile)
	want := "-p analyst-echo gateway run --replace"
	if got != want {
		t.Errorf("ordinary profile start args:\n got %q\nwant %q", got, want)
	}
}

// TestHermesStart_UnknownRootIdentityLeavesProfilesStartable proves the guard
// is inert when the identities cannot be compared: a home with no resolvable
// Matrix identity flags nothing, so every profile behaves exactly as it does
// today. Without this, a host whose identity lives somewhere we cannot read
// would silently lose the ability to start its profiles.
func TestHermesStart_UnknownRootIdentityLeavesProfilesStartable(t *testing.T) {
	home := t.TempDir() // no .env / auth.json / config.yaml anywhere
	profile := filepath.Join(home, "profiles", "buddhimaan")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatalf("mkdir profile: %v", err)
	}

	dir := t.TempDir()
	argsFile := filepath.Join(dir, "hermes.args")
	writeRecorderStub(t, filepath.Join(dir, "hermes"), argsFile)
	t.Setenv("PATH", dir)

	lc := NewHermes(home).(Lifecycle)
	if err := lc.Start("hermes:buddhimaan"); err != nil {
		t.Fatalf("Start with unresolvable identities must behave as before: %v", err)
	}
	if got := waitForStubArgs(t, argsFile); got != "-p buddhimaan gateway run --replace" {
		t.Errorf("unexpected start args %q", got)
	}
}

// TestHermesHealth_DefaultProfileReportsRootGateway proves the health view
// agrees with the lifecycle rule: the default-gateway profile reports the ROOT
// gateway's liveness (it is the same process) and carries a note saying so, so
// the console does not show a live agent as "stopped" with no way to start it.
//
// An ordinary profile keeps its own per-process reading and no note.
func TestHermesHealth_DefaultProfileReportsRootGateway(t *testing.T) {
	home := defaultProfileHome(t)

	// pgrep stub: matches ONLY the broad root pattern ("hermes"), never a
	// per-profile pattern — exactly the situation on the affected host, where the
	// root gateway runs and no `-p <name> gateway` process exists. It reports this
	// test process's PID so the metrics lookup (real `ps`) succeeds.
	dir := t.TempDir()
	script := fmt.Sprintf(`#!/bin/sh
case "$2" in
  hermes) echo %d; exit 0 ;;
  *) exit 1 ;;
esac
`, os.Getpid())
	if err := os.WriteFile(filepath.Join(dir, "pgrep"), []byte(script), 0o755); err != nil {
		t.Fatalf("write pgrep stub: %v", err)
	}
	prependPath(t, dir) // keep the real `ps` reachable

	d := NewHermes(home)

	def, err := d.Health("hermes:buddhimaan")
	if err != nil {
		t.Fatalf("Health(default profile): %v", err)
	}
	if !def.Running {
		t.Error("default-gateway profile must report the root gateway's liveness (running)")
	}
	if def.PID == nil || *def.PID != os.Getpid() {
		t.Errorf("default-gateway profile must report the root gateway PID, got %v", def.PID)
	}
	if def.Note == nil || !strings.Contains(*def.Note, "gateway") {
		t.Errorf("default-gateway profile must carry an explanatory note, got %v", def.Note)
	}

	other, err := d.Health("hermes:analyst-echo")
	if err != nil {
		t.Fatalf("Health(ordinary profile): %v", err)
	}
	if other.Running {
		t.Error("an ordinary profile must NOT inherit the root gateway's liveness")
	}
	if other.Note != nil {
		t.Errorf("an ordinary profile must not gain a note, got %q", *other.Note)
	}
}

// TestMatrixIDFromProfile_ReadsEnvUserIDOnly proves the identity reader also
// covers the deployment shape used on the fleet (identity in .env), and that it
// reads ONLY MATRIX_USER_ID — never MATRIX_ACCESS_TOKEN.
func TestMatrixIDFromProfile_ReadsEnvUserIDOnly(t *testing.T) {
	dir := t.TempDir()
	body := "# comment\nMATRIX_ACCESS_TOKEN=syt_SECRET_TOKEN\nexport MATRIX_USER_ID=\"@buddhimaan:id.agentpod.dev\"\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(body), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	got := MatrixIDFromProfile(dir, "id.agentpod.dev")
	if got == nil || *got != "@buddhimaan:id.agentpod.dev" {
		t.Fatalf("want mxid from .env, got %v", got)
	}
	if strings.Contains(*got, "SECRET") {
		t.Fatalf("token leaked: %q", *got)
	}

	// A .env with only a token yields nothing at all.
	tokenOnly := t.TempDir()
	if err := os.WriteFile(filepath.Join(tokenOnly, ".env"), []byte("MATRIX_ACCESS_TOKEN=syt_SECRET_TOKEN\n"), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	if mxid := MatrixIDFromProfile(tokenOnly, "id.agentpod.dev"); mxid != nil {
		t.Fatalf("want nil when only a token is present, got %q", *mxid)
	}
}

// assertNoStubRan waits briefly and fails if any of the given marker files
// appeared. Launch paths are detached, so absence needs a settle window.
func assertNoStubRan(t *testing.T, markers ...string) {
	t.Helper()
	time.Sleep(300 * time.Millisecond)
	for _, m := range markers {
		if b, err := os.ReadFile(m); err == nil && len(b) > 0 {
			t.Errorf("a launch path ran (%s recorded %q) — no gateway may be spawned for the default profile", filepath.Base(m), strings.TrimSpace(string(b)))
		} else if err == nil {
			t.Errorf("a launch path ran (%s exists) — no gateway may be spawned for the default profile", filepath.Base(m))
		}
	}
}
