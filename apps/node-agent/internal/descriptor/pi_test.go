package descriptor

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// buildPiFixture creates <tmp>/sessions/<encoded>/<ts>_<uuid>.jsonl files whose
// first line carries the workspace path verbatim, plus a session dir with no
// jsonl at all (observed live: `pi --mode rpc` creates the dir without a session).
func buildPiFixture(t *testing.T) (dataDir string, wsHyphen string) {
	t.Helper()
	root := t.TempDir()
	dataDir = filepath.Join(root, "agent")

	// Point the workspace station at a path that does not exist, so these cases
	// see session-derived stations ONLY. Without it a machine that happens to
	// have a /workspace (any provisioned container, and some developer laptops)
	// would report one more station than the case is about. The workspace
	// station has its own file: pi_workspace_test.go.
	t.Setenv(piWorkspaceEnv, filepath.Join(root, "no-workspace"))

	// A real workspace whose name CONTAINS A HYPHEN. Decoding the directory
	// name would yield ".../idea/bank", which does not exist — the station
	// would vanish silently. This is the case that forces header parsing.
	wsHyphen = filepath.Join(root, "Projects", "idea-bank")
	if err := os.MkdirAll(wsHyphen, 0o755); err != nil {
		t.Fatal(err)
	}
	writePiSession(t, dataDir, "--"+strings.ReplaceAll(strings.TrimPrefix(wsHyphen, "/"), "/", "-")+"--", wsHyphen)

	// A session dir with NO jsonl — must be skipped, never guessed at.
	if err := os.MkdirAll(filepath.Join(dataDir, "sessions", "--private-tmp--"), 0o755); err != nil {
		t.Fatal(err)
	}

	// A session whose workspace no longer exists — must be filtered out.
	writePiSession(t, dataDir, "--gone--", filepath.Join(root, "deleted"))
	return dataDir, wsHyphen
}

func writePiSession(t *testing.T, dataDir, encoded, cwd string) {
	t.Helper()
	dir := filepath.Join(dataDir, "sessions", encoded)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	header := fmt.Sprintf(`{"type":"session","version":3,"id":"x","timestamp":"2026-08-12T08:10:23.796Z","cwd":%q}`, cwd)
	if err := os.WriteFile(filepath.Join(dir, "2026-08-12T08-10-23-796Z_uuid.jsonl"), []byte(header+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPiDetectReadsWorkspaceFromSessionHeader(t *testing.T) {
	dataDir, wsHyphen := buildPiFixture(t)
	stations, err := NewPi(dataDir).Detect()
	if err != nil {
		t.Fatal(err)
	}
	if len(stations) != 1 {
		t.Fatalf("want 1 station, got %d: %+v", len(stations), stations)
	}
	s := stations[0]
	if s.WorkspacePath == nil || *s.WorkspacePath != wsHyphen {
		t.Errorf("workspace = %v, want %s (a hyphenated path must survive)", s.WorkspacePath, wsHyphen)
	}
	if s.Harness != "pi" {
		t.Errorf("harness = %q, want pi", s.Harness)
	}
	if s.Key != piProjectKey(wsHyphen) {
		t.Errorf("key = %q", s.Key)
	}
}

func TestPiDetectMissingDataDirReturnsEmpty(t *testing.T) {
	// No workspace either — a missing data dir with a workspace present is the
	// freshly-provisioned case, and it is covered in pi_workspace_test.go.
	t.Setenv(piWorkspaceEnv, filepath.Join(t.TempDir(), "no-workspace"))
	stations, err := NewPi(filepath.Join(t.TempDir(), "nope")).Detect()
	if err != nil {
		t.Fatalf("missing data dir must not error: %v", err)
	}
	if len(stations) != 0 {
		t.Errorf("want empty, got %+v", stations)
	}
}

// piDescriptor must satisfy Cleaner, or Detect's "cleanup" capability is a lie
// (the gateway advertises cleanup only for descriptors implementing Cleaner).
var _ Cleaner = (*piDescriptor)(nil)

// fakePiBinary writes an executable file that looks like a Pi entrypoint and
// returns its path. Nothing is spawned from it, so a health check pointed at
// it must report Running=false — which makes every health test hermetic on a
// developer machine that happens to have a real Pi session open.
func fakePiBinary(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "pi")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// spawnPiStub copies THIS test binary to path and runs it with args, giving
// pgrep a real process with a real command line to match. The copy re-execs
// into the sleep branch of TestMain (claudecode_test.go — a package may only
// have one, so Pi's stubs reuse it rather than declaring another).
//
// Copying /bin/sleep is not an option: macOS SIGKILLs relocated platform
// binaries. The child is killed AND reaped on cleanup — an unreaped zombie
// would leak into the other pgrep-based tests in this package.
func spawnPiStub(t *testing.T, path string, args ...string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, src, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(path, args...)
	cmd.Env = append(os.Environ(), "CLAUDE_STUB_SLEEP=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})
	// Give the stub a moment to exec before pgrep looks for it.
	time.Sleep(300 * time.Millisecond)
}

func TestPiHealthNoProcessIsNotAnError(t *testing.T) {
	t.Setenv(piBinaryEnv, fakePiBinary(t))
	dataDir, ws := buildPiFixture(t)
	h, err := NewPi(dataDir).Health(piProjectKey(ws))
	if err != nil {
		t.Fatalf("health must not error when Pi is not running: %v", err)
	}
	if h.Running {
		t.Error("Running should be false with no pi process")
	}
	// pgrep exit 1 means "no match", which is the NORMAL state for a daemonless
	// harness — it must not surface as a health note.
	if h.Note != nil {
		t.Errorf("Note = %q, want none: no matching process is not a fault", *h.Note)
	}
}

func TestPiHealthReportsLastActivityFromSessionDir(t *testing.T) {
	t.Setenv(piBinaryEnv, fakePiBinary(t))
	dataDir, ws := buildPiFixture(t)
	h, err := NewPi(dataDir).Health(piProjectKey(ws))
	if err != nil {
		t.Fatal(err)
	}
	if h.LastActivity == nil {
		t.Fatal("LastActivity is nil: the station's session dir has a transcript in it")
	}
	if _, err := time.Parse(time.RFC3339, *h.LastActivity); err != nil {
		t.Errorf("LastActivity = %q, want RFC3339: %v", *h.LastActivity, err)
	}
}

// TestPiHealthDetectsRpcProcess is the positive half of the pgrep pattern
// contract: a real process whose command line is "<pi path> --mode rpc" must
// be seen. Without it, the negative test below could be satisfied by a pattern
// that matches nothing at all.
func TestPiHealthDetectsRpcProcess(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	piPath := filepath.Join(t.TempDir(), "bin", "pi")
	spawnPiStub(t, piPath, "--mode", "rpc")
	t.Setenv(piBinaryEnv, piPath)

	h, err := NewPi(dataDir).Health(piProjectKey(ws))
	if err != nil {
		t.Fatal(err)
	}
	if !h.Running {
		note := ""
		if h.Note != nil {
			note = *h.Note
		}
		t.Fatalf("Running = false with `%s --mode rpc` alive (note=%q)", piPath, note)
	}
}

// TestPiHealthIgnoresProcessMerelyMentioningPi is the self-match regression.
//
// Observed live on 2026-08-12: `pgrep -f "dist/cli.js"` matched the shell
// running it, because that shell's own command line contained the pattern
// text. This test reproduces exactly that shape — a process that is NOT Pi but
// whose command line carries the Pi entry path AND "--mode rpc" as arguments,
// as any pgrep caller, ps grep or debugging shell would. It is the same class
// of bug that twice broke opencode health (the broad "opencode" pattern
// matching docker-init's cmdline).
func TestPiHealthIgnoresProcessMerelyMentioningPi(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	piPath := fakePiBinary(t)
	// argv: <stub> -f <piPath> --mode rpc  — i.e. what our own process check
	// looks like from the outside. Nothing here is a Pi process.
	spawnPiStub(t, filepath.Join(t.TempDir(), "pgrep-caller"), "-f", piPath, "--mode", "rpc")
	t.Setenv(piBinaryEnv, piPath)

	h, err := NewPi(dataDir).Health(piProjectKey(ws))
	if err != nil {
		t.Fatal(err)
	}
	if h.Running {
		t.Fatal("Running = true for a process that merely mentions the Pi path in its arguments")
	}
}

func TestPiHealthUnknownKeyErrors(t *testing.T) {
	dataDir, _ := buildPiFixture(t)
	if _, err := NewPi(dataDir).Health("pi:deadbeef"); err == nil {
		t.Error("expected an error for an unknown station key")
	}
}

func TestPiListDirRejectsEscape(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	if _, err := NewPi(dataDir).ListDir(piProjectKey(ws), "../.."); err == nil {
		t.Error("expected .. escape to be rejected")
	}
}

func TestPiListDirListsWorkspace(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	if err := os.WriteFile(filepath.Join(ws, "notes.md"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(ws, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	entries, err := NewPi(dataDir).ListDir(piProjectKey(ws), ".")
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, e := range entries {
		kinds[e.Name] = e.Type
	}
	if kinds["notes.md"] != "file" {
		t.Errorf("notes.md type = %q, want file", kinds["notes.md"])
	}
	if kinds["src"] != "dir" {
		t.Errorf("src type = %q, want dir", kinds["src"])
	}
}

func TestPiReadFileTruncatesAtMaxBytes(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	content := bytes.Repeat([]byte("x"), 100)
	if err := os.WriteFile(filepath.Join(ws, "big.txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	p := NewPi(dataDir)

	got, _, truncated, err := p.ReadFile(piProjectKey(ws), "big.txt", 10)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated {
		t.Error("truncated = false for a 100-byte file read with maxBytes=10")
	}
	if len(got) != 10 {
		t.Errorf("read %d bytes, want 10", len(got))
	}

	got, _, truncated, err = p.ReadFile(piProjectKey(ws), "big.txt", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if truncated || len(got) != 100 {
		t.Errorf("full read: got %d bytes truncated=%v, want 100 false", len(got), truncated)
	}
}

func TestPiReadFileRejectsEscape(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	if _, _, _, err := NewPi(dataDir).ReadFile(piProjectKey(ws), "../../etc/passwd", 100); err == nil {
		t.Error("expected .. escape to be rejected")
	}
}

func TestPiTailLogsWithNoLogFileDoesNotError(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	err := NewPi(dataDir).TailLogs(context.Background(), piProjectKey(ws), false, func([]byte) error { return nil })
	if err != nil {
		t.Fatalf("absent pi-debug.log must not error: %v", err)
	}
}

func TestPiTailLogsEmitsDebugLog(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "pi-debug.log"), []byte("line one\nline two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	err := NewPi(dataDir).TailLogs(context.Background(), piProjectKey(ws), false, func(b []byte) error {
		got.Write(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.String(), "line two") {
		t.Errorf("emitted %q, want the contents of pi-debug.log", got.String())
	}
}

// TestPiTailLogsFollowWaitsForLogFile guards the 2026-08-09 dogfooding bug:
// follow mode with zero log files used to return immediately, the hub closed
// the SSE, and the console's Logs tab retry-looped into "Disconnected". Pi is
// the worst case for this — pi-debug.log only exists once the hidden /debug is
// enabled, so it is absent on nearly every station.
func TestPiTailLogsFollowWaitsForLogFile(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- NewPi(dataDir).TailLogs(ctx, piProjectKey(ws), true, func([]byte) error { return nil })
	}()

	select {
	case err := <-done:
		t.Fatalf("follow mode returned immediately with no log file (err=%v)", err)
	case <-time.After(300 * time.Millisecond):
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("follow mode returned %v after cancel, want nil", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("follow mode did not return after ctx cancel")
	}
}

func TestPiTailLogsUnknownKeyErrors(t *testing.T) {
	dataDir, _ := buildPiFixture(t)
	err := NewPi(dataDir).TailLogs(context.Background(), "pi:deadbeef", false, func([]byte) error { return nil })
	if err == nil {
		t.Error("expected an error for an unknown station key")
	}
}

// TestPiCleanPlanClaimsOnlyVerifiedPaths pins the deliberate decision that no
// Pi cache directory has been verified on a real machine, so none is offered.
// A guessed entry here is a path the console would invite a user to DELETE.
// Widening the list is fine — but only with an observation to back it up, and
// this test is where that evidence gets recorded.
func TestPiCleanPlanClaimsOnlyVerifiedPaths(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	// A plausible-looking but UNVERIFIED directory, plus a root *.log file
	// (which cleanPlanCommon offers for every harness).
	if err := os.MkdirAll(filepath.Join(ws, ".pi", "cache"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "build.log"), []byte("noise\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cleaner, ok := NewPi(dataDir).(Cleaner)
	if !ok {
		t.Fatal("piDescriptor does not implement Cleaner")
	}
	plan, err := cleaner.CleanPlan(piProjectKey(ws))
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range plan {
		if !strings.HasSuffix(strings.ToLower(item.Path), ".log") {
			t.Errorf("CleanPlan offers %q, which is not a verified-cleanable path", item.Path)
		}
	}
	found := false
	for _, item := range plan {
		if item.Path == "build.log" {
			found = true
		}
	}
	if !found {
		t.Errorf("CleanPlan = %+v, want the root build.log", plan)
	}
}

// TestPiCleanApplyRefusesOffPlanPaths checks the second safety of
// cleanApplyCommon: a path the plan never offered is never removed, even when
// it exists and is inside the workspace.
func TestPiCleanApplyRefusesOffPlanPaths(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	src := filepath.Join(ws, "main.go")
	if err := os.WriteFile(src, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	logFile := filepath.Join(ws, "build.log")
	if err := os.WriteFile(logFile, []byte("noise\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cleaner := NewPi(dataDir).(Cleaner)
	if _, err := cleaner.CleanApply(piProjectKey(ws), []string{"main.go", "../escape", "build.log"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(src); err != nil {
		t.Errorf("CleanApply removed an off-plan source file: %v", err)
	}
	if _, err := os.Stat(logFile); !os.IsNotExist(err) {
		t.Errorf("build.log survived CleanApply (err=%v)", err)
	}
}
