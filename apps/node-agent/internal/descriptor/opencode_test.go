package descriptor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// buildOpenCodeFixture creates a temporary OpenCode data directory suitable for
// testing. Returns the dataDir and the real project path that was registered.
// t.Cleanup removes the temp tree automatically.
//
// Layout created:
//
//	<root>/
//	  project/
//	    global/                           ← must be skipped by Detect
//	    <sanitised real project path>/    ← should appear as a station
//	    <sanitised ghost path>/           ← decoded path doesn't exist → filtered
//	  log/
//	    test.log                          ← sample log content
func buildOpenCodeFixture(t *testing.T) (dataDir, projPath string) {
	t.Helper()

	root := t.TempDir()
	dataDir = filepath.Join(root, "opencode")

	// Create a real project directory with at least one file.
	projPath = filepath.Join(root, "myproject")
	if err := os.MkdirAll(projPath, 0o755); err != nil {
		t.Fatalf("MkdirAll projPath: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Sanitise: strip leading '/', replace '/' with '-'.
	sanitise := func(p string) string {
		return strings.ReplaceAll(strings.TrimPrefix(p, "/"), "/", "-")
	}

	// Create project/ subdirs.
	projsDir := filepath.Join(dataDir, "project")

	// global/ entry — Detect must skip this.
	if err := os.MkdirAll(filepath.Join(projsDir, "global"), 0o755); err != nil {
		t.Fatalf("MkdirAll global: %v", err)
	}

	// Real project entry.
	realSanitised := sanitise(projPath)
	realProjDataDir := filepath.Join(projsDir, realSanitised)
	if err := os.MkdirAll(realProjDataDir, 0o755); err != nil {
		t.Fatalf("MkdirAll real proj data dir: %v", err)
	}
	// Write an activity file so LastActivity is non-nil.
	if err := os.WriteFile(filepath.Join(realProjDataDir, "app.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}

	// Ghost project entry: decoded path will not exist on disk.
	// Use a name that decodes to a nonexistent path.
	ghostSanitised := "nonexistent-ghost-project-abc"
	if err := os.MkdirAll(filepath.Join(projsDir, ghostSanitised), 0o755); err != nil {
		t.Fatalf("MkdirAll ghost proj data dir: %v", err)
	}

	// Create log/ directory with a sample log file.
	logDir := filepath.Join(dataDir, "log")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatalf("MkdirAll logDir: %v", err)
	}
	logContent := "2026-01-01T00:00:00Z info opencode started\n2026-01-01T00:00:01Z info session ready\n"
	if err := os.WriteFile(filepath.Join(logDir, "test.log"), []byte(logContent), 0o644); err != nil {
		t.Fatal(err)
	}

	return dataDir, projPath
}

// expectedOpenCodeKey computes the station key for a project path, mirroring
// the production implementation so tests can assert exact keys.
func expectedOpenCodeKey(projPath string) string {
	h := sha256.Sum256([]byte(projPath))
	return fmt.Sprintf("opencode:%x", h[:4])
}

// --- Detect ---

func TestOpenCodeDetect_ReturnsOneLeafStation(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	// Only the real project should appear; global and ghost are filtered.
	if len(stations) != 1 {
		t.Fatalf("expected exactly 1 station, got %d: %+v", len(stations), stations)
	}

	s := stations[0]
	wantKey := expectedOpenCodeKey(projPath)
	if s.Key != wantKey {
		t.Errorf("key: want %q, got %q", wantKey, s.Key)
	}
	if s.Harness != "opencode" {
		t.Errorf("harness: want opencode, got %q", s.Harness)
	}
	if s.Kind != "leaf" {
		t.Errorf("kind: want leaf, got %q", s.Kind)
	}
	if s.ParentKey != nil {
		t.Errorf("parentKey: want nil, got %v", s.ParentKey)
	}
	if s.MatrixId != nil {
		t.Errorf("matrixId: want nil, got %v", s.MatrixId)
	}
	if s.WorkspacePath == nil || *s.WorkspacePath != projPath {
		t.Errorf("workspacePath: want %q, got %v", projPath, s.WorkspacePath)
	}
	if s.DisplayName != filepath.Base(projPath) {
		t.Errorf("displayName: want %q, got %q", filepath.Base(projPath), s.DisplayName)
	}

	capSet := make(map[string]bool)
	for _, c := range s.Capabilities {
		capSet[c] = true
	}
	for _, want := range []string{"health", "logs", "fs.read", "fs.write", "terminal", "cleanup"} {
		if !capSet[want] {
			t.Errorf("missing capability %q in %v", want, s.Capabilities)
		}
	}
}

func TestOpenCodeDetect_GlobalSkipped(t *testing.T) {
	dataDir, _ := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	for _, s := range stations {
		if s.DisplayName == "global" {
			t.Errorf("global entry should have been skipped: %+v", s)
		}
		if s.WorkspacePath != nil && *s.WorkspacePath == "/global" {
			t.Errorf("global workspace path should not appear: %+v", s)
		}
	}
}

func TestOpenCodeDetect_GhostPathFiltered(t *testing.T) {
	dataDir, _ := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	for _, s := range stations {
		if s.WorkspacePath != nil && strings.Contains(*s.WorkspacePath, "ghost") {
			t.Errorf("ghost path should have been filtered: %+v", s)
		}
	}
}

func TestOpenCodeDetect_MissingDataDirReturnsEmpty(t *testing.T) {
	d := NewOpenCode("/nonexistent/opencode/data/dir")
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect on missing dataDir: %v", err)
	}
	if len(stations) != 0 {
		t.Fatalf("expected empty stations, got %d: %+v", len(stations), stations)
	}
}

// --- Health ---

func TestOpenCodeHealth_ReturnsDiskBytes(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	key := expectedOpenCodeKey(projPath)
	// DiskBytes populates asynchronously (cached background walk).
	disk := waitForHealthDiskBytes(t, func() (Health, error) { return d.Health(key) })
	if disk <= 0 {
		t.Errorf("DiskBytes should be > 0 for a workspace with a file, got %d", disk)
	}
	h, err := d.Health(key)
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	// Running is best-effort; just ensure no panic.
	_ = h.Running
}

func TestOpenCodeHealth_LastActivitySet(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	key := expectedOpenCodeKey(projPath)
	h, err := d.Health(key)
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	// The fixture writes app.json into the per-project data dir, so
	// LastActivity must be populated.
	if h.LastActivity == nil || *h.LastActivity == "" {
		t.Error("expected LastActivity to be set when project data dir contains files")
	}
}

// --- ListDir ---

func TestOpenCodeListDir_ProjectDir(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	key := expectedOpenCodeKey(projPath)
	entries, err := d.ListDir(key, "")
	if err != nil {
		t.Fatalf("ListDir: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least one entry")
	}
	var found bool
	for _, e := range entries {
		if e.Name == "main.go" {
			found = true
		}
	}
	if !found {
		t.Errorf("main.go not found in entries: %+v", entries)
	}
}

func TestOpenCodeListDir_DotDotEscape(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	key := expectedOpenCodeKey(projPath)
	_, err := d.ListDir(key, "../../../etc")
	if err == nil {
		t.Fatal("expected error for .. escape")
	}
}

// --- ReadFile ---

func TestOpenCodeReadFile_ReadsContent(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	key := expectedOpenCodeKey(projPath)
	content, _, truncated, err := d.ReadFile(key, "main.go", 0)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if truncated {
		t.Error("expected not truncated for small file")
	}
	if !strings.Contains(string(content), "package main") {
		t.Errorf("content should contain 'package main', got: %s", content)
	}
}

func TestOpenCodeReadFile_Truncation(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	key := expectedOpenCodeKey(projPath)
	content, _, truncated, err := d.ReadFile(key, "main.go", 5)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !truncated {
		t.Error("expected truncated=true when maxBytes < file size")
	}
	if len(content) != 5 {
		t.Errorf("expected 5 bytes, got %d", len(content))
	}
}

func TestOpenCodeReadFile_DotDotEscape(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	key := expectedOpenCodeKey(projPath)
	_, _, _, err := d.ReadFile(key, "../escape/secret.txt", 0)
	if err == nil {
		t.Fatal("expected error for .. escape")
	}
}

// --- TailLogs ---

func TestOpenCodeTailLogs_EmitsLogContent(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	key := expectedOpenCodeKey(projPath)
	var chunks [][]byte
	err := d.TailLogs(context.Background(), key, false, func(b []byte) error {
		chunks = append(chunks, b)
		return nil
	})
	if err != nil {
		t.Fatalf("TailLogs: %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least one chunk from the test.log file")
	}
	var all string
	for _, c := range chunks {
		all += string(c)
	}
	if !strings.Contains(all, "opencode") {
		t.Errorf("expected log content containing 'opencode', got: %s", all)
	}
}

func TestOpenCodeTailLogs_NoLogDir_EmitsNothing(t *testing.T) {
	// Use a dataDir with a valid project/ but no log/ directory.
	root := t.TempDir()
	dataDir := filepath.Join(root, "opencode")

	projPath := filepath.Join(root, "emptyproj")
	if err := os.MkdirAll(projPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "readme.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	sanitise := func(p string) string {
		return strings.ReplaceAll(strings.TrimPrefix(p, "/"), "/", "-")
	}
	projDataDir := filepath.Join(dataDir, "project", sanitise(projPath))
	if err := os.MkdirAll(projDataDir, 0o755); err != nil {
		t.Fatal(err)
	}

	d := NewOpenCode(dataDir)
	key := expectedOpenCodeKey(projPath)

	var count int
	err := d.TailLogs(context.Background(), key, false, func(b []byte) error {
		count++
		return nil
	})
	if err != nil {
		t.Fatalf("TailLogs without log dir: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 chunks when log dir absent, got %d", count)
	}
}

// --- DB primary path + deduplication ---

// TestOpenCodeDetect_DBPrimary exercises the projectPathsFromDB (primary) code
// path and Fix 1 (dedup by workspace path). It creates a minimal opencode.db
// via the sqlite3 CLI and asserts:
//   - the "global" row is excluded
//   - a row whose worktree is an existing temp dir appears exactly once
//   - two rows sharing the same worktree are collapsed to a single station
//
// If sqlite3 is not on PATH the test is skipped (matches graceful-fallback
// semantics — the suite must not fail on machines without sqlite3).
func TestOpenCodeDetect_DBPrimary(t *testing.T) {
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 not on PATH; skipping DB primary path test")
	}

	root := t.TempDir()
	dataDir := filepath.Join(root, "opencode")

	// project/ dir must exist for Detect() to proceed.
	projsDir := filepath.Join(dataDir, "project")
	if err := os.MkdirAll(projsDir, 0o755); err != nil {
		t.Fatalf("MkdirAll projsDir: %v", err)
	}

	// A real workspace directory that will be referenced by two DB rows.
	realWorkspace := filepath.Join(root, "periscope-workspace")
	if err := os.MkdirAll(realWorkspace, 0o755); err != nil {
		t.Fatalf("MkdirAll realWorkspace: %v", err)
	}

	// Build opencode.db with the same schema the production query expects:
	// table "project", columns "id" and "worktree".
	// Rows inserted:
	//   global  → must be excluded by WHERE id != 'global'
	//   proj1   → realWorkspace (must appear)
	//   proj2   → realWorkspace again (must be deduped; Fix 1)
	dbPath := filepath.Join(dataDir, "opencode.db")
	setupSQL := strings.Join([]string{
		`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);`,
		`INSERT INTO project VALUES ('global', '/some/global/path');`,
		`INSERT INTO project VALUES ('proj1', '` + realWorkspace + `');`,
		`INSERT INTO project VALUES ('proj2', '` + realWorkspace + `');`,
	}, "\n")

	cmd := exec.Command("sqlite3", dbPath, setupSQL)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sqlite3 db setup failed: %v\n%s", err, out)
	}

	d := NewOpenCode(dataDir)
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	// global excluded; proj1 and proj2 share the same worktree → 1 station.
	if len(stations) != 1 {
		t.Fatalf("expected exactly 1 station (global excluded, duplicate collapsed), got %d: %+v", len(stations), stations)
	}

	s := stations[0]
	if s.WorkspacePath == nil || *s.WorkspacePath != realWorkspace {
		t.Errorf("workspacePath: want %q, got %v", realWorkspace, s.WorkspacePath)
	}
	wantKey := expectedOpenCodeKey(realWorkspace)
	if s.Key != wantKey {
		t.Errorf("key: want %q, got %q", wantKey, s.Key)
	}
	if s.Harness != "opencode" {
		t.Errorf("harness: want opencode, got %q", s.Harness)
	}
	if s.Kind != "leaf" {
		t.Errorf("kind: want leaf, got %q", s.Kind)
	}
}

// --- Lifecycle capability gating ---

// TestOpenCodeDetect_LifecycleCapability_UngatedByDefault asserts that a
// bare-metal opencode host (no AGENTPOD_OPENCODE_SUPERVISED env var) never
// advertises "lifecycle" — it has no supervised process for Stop/Start to
// control.
func TestOpenCodeDetect_LifecycleCapability_UngatedByDefault(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	key := expectedOpenCodeKey(projPath)
	s := findOpenCodeStation(t, stations, key)
	if hasCapability(s.Capabilities, "lifecycle") {
		t.Errorf("capabilities should NOT include 'lifecycle' without AGENTPOD_OPENCODE_SUPERVISED, got %v", s.Capabilities)
	}
}

// TestOpenCodeDetect_LifecycleCapability_WhenSupervised asserts that setting
// AGENTPOD_OPENCODE_SUPERVISED=1 (as the provisioned-opencode entrypoint
// does) adds "lifecycle" to the station's capabilities.
func TestOpenCodeDetect_LifecycleCapability_WhenSupervised(t *testing.T) {
	t.Setenv("AGENTPOD_OPENCODE_SUPERVISED", "1")
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	key := expectedOpenCodeKey(projPath)
	s := findOpenCodeStation(t, stations, key)
	if !hasCapability(s.Capabilities, "lifecycle") {
		t.Errorf("capabilities should include 'lifecycle' when AGENTPOD_OPENCODE_SUPERVISED=1, got %v", s.Capabilities)
	}
}

func findOpenCodeStation(t *testing.T, stations []Station, key string) Station {
	t.Helper()
	for _, s := range stations {
		if s.Key == key {
			return s
		}
	}
	t.Fatalf("station %q not found in %+v", key, stations)
	return Station{}
}

func hasCapability(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}

// --- Lifecycle Stop/Start ---

// writeFakePgrepPID writes an executable "pgrep" stub in tmpDir. It logs its
// invocation args (space-joined) to argsFile, then prints pid and exits 0 —
// simulating a matching `opencode serve` process without depending on the
// real opencode binary or a real pgrep -f substring match.
func writeFakePgrepPID(t *testing.T, tmpDir string, pid int, argsFile string) {
	t.Helper()
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %s
echo %d
exit 0
`, argsFile, pid)
	if err := os.WriteFile(filepath.Join(tmpDir, "pgrep"), []byte(script), 0o755); err != nil {
		t.Fatalf("writeFakePgrepPID: %v", err)
	}
}

// TestOpenCodeLifecycle_Stop_NoProcess_ReturnsError asserts that Stop returns
// an error when no `opencode serve` process can be found (pgrep exits 1, as
// on a fresh runtime with nothing running yet).
func TestOpenCodeLifecycle_Stop_NoProcess_ReturnsError(t *testing.T) {
	t.Setenv("AGENTPOD_OPENCODE_SUPERVISED", "1")
	tmpDir := t.TempDir()
	writeFakePgrep(t, tmpDir) // from hermes_lifecycle_systemd_test.go: always exits 1
	t.Setenv("PATH", tmpDir+":"+os.Getenv("PATH"))

	o := &openCodeDescriptor{}
	if err := o.Stop("opencode:abc"); err == nil {
		t.Fatal("expected error when no opencode serve process is running")
	}
}

// TestOpenCodeLifecycle_Stop_UsesExpectedPgrepPattern asserts that Stop
// queries pgrep with the exact "-f opencode.*serve" pattern the entrypoint's
// supervised process matches.
func TestOpenCodeLifecycle_Stop_UsesExpectedPgrepPattern(t *testing.T) {
	t.Setenv("AGENTPOD_OPENCODE_SUPERVISED", "1")
	tmpDir := t.TempDir()
	argsFile := filepath.Join(tmpDir, "pgrep.args")

	// A real process for the fake pgrep to "find" and for stopProcess to kill.
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	defer func() { _ = cmd.Wait() }()

	writeFakePgrepPID(t, tmpDir, cmd.Process.Pid, argsFile)
	t.Setenv("PATH", tmpDir+":"+os.Getenv("PATH"))
	withTempSentinel(t)

	o := &openCodeDescriptor{}
	if err := o.Stop("opencode:abc"); err != nil {
		_ = cmd.Process.Kill()
		t.Fatalf("Stop: %v", err)
	}

	got := readLog(t, argsFile)
	if !strings.Contains(got, "-f opencode.*serve") {
		t.Errorf("expected pgrep invoked with '-f opencode.*serve', got %q", got)
	}
}

// TestOpenCodeLifecycle_Stop_KillsProcessAndTouchesSentinel is the core
// regression: Stop must both terminate the running `opencode serve` process
// AND leave the stop sentinel behind so the entrypoint's supervision loop
// halts instead of resurrecting it within 2s (which would make Stop a no-op).
func TestOpenCodeLifecycle_Stop_KillsProcessAndTouchesSentinel(t *testing.T) {
	t.Setenv("AGENTPOD_OPENCODE_SUPERVISED", "1")
	tmpDir := t.TempDir()
	argsFile := filepath.Join(tmpDir, "pgrep.args")

	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	defer func() { _ = cmd.Wait() }()
	pid := cmd.Process.Pid

	writeFakePgrepPID(t, tmpDir, pid, argsFile)
	t.Setenv("PATH", tmpDir+":"+os.Getenv("PATH"))
	sentinel := withTempSentinel(t)

	o := &openCodeDescriptor{}
	if err := o.Stop("opencode:abc"); err != nil {
		_ = cmd.Process.Kill()
		t.Fatalf("Stop: %v", err)
	}

	if err := cmd.Process.Signal(syscall.Signal(0)); err == nil {
		_ = cmd.Process.Kill()
		t.Fatal("process still alive after Stop")
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Errorf("expected stop sentinel %q to exist after Stop: %v", sentinel, err)
	}
}

// withTempSentinel points openCodeServeSentinelPath at a path inside a fresh
// t.TempDir() for the duration of the test and restores it afterward — Stop
// and Start must never touch the real /var/run path in tests.
func withTempSentinel(t *testing.T) string {
	t.Helper()
	sentinel := filepath.Join(t.TempDir(), "opencode-serve.stop")
	orig := openCodeServeSentinelPath
	openCodeServeSentinelPath = sentinel
	t.Cleanup(func() { openCodeServeSentinelPath = orig })
	return sentinel
}

// withTempServeLog points openCodeServeLogPath at a path inside a fresh
// t.TempDir() for the duration of the test.
func withTempServeLog(t *testing.T) string {
	t.Helper()
	logPath := filepath.Join(t.TempDir(), "opencode-serve.log")
	orig := openCodeServeLogPath
	openCodeServeLogPath = logPath
	t.Cleanup(func() { openCodeServeLogPath = orig })
	return logPath
}

// withTempWorkspaceDir points openCodeWorkspaceDir at dir for the duration of
// the test.
func withTempWorkspaceDir(t *testing.T, dir string) {
	t.Helper()
	orig := openCodeWorkspaceDir
	openCodeWorkspaceDir = dir
	t.Cleanup(func() { openCodeWorkspaceDir = orig })
}

// TestOpenCodeLifecycle_Start_RemovesSentinelAndSpawnsServeInWorkspace
// asserts that Start clears the stop sentinel (so a subsequent lifecycle
// action isn't confused by a stale one) and re-spawns `opencode serve` cd'd
// into the workspace, appending output to the shared serve log.
func TestOpenCodeLifecycle_Start_RemovesSentinelAndSpawnsServeInWorkspace(t *testing.T) {
	t.Setenv("AGENTPOD_OPENCODE_SUPERVISED", "1")
	stubDir := t.TempDir()
	argsFile := filepath.Join(stubDir, "opencode.args")
	cwdFile := filepath.Join(stubDir, "opencode.cwd")
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s' "$*" > %s
pwd > %s
`, argsFile, cwdFile)
	if err := os.WriteFile(filepath.Join(stubDir, "opencode"), []byte(script), 0o755); err != nil {
		t.Fatalf("write opencode stub: %v", err)
	}
	t.Setenv("PATH", stubDir+":"+os.Getenv("PATH"))

	workspace := t.TempDir()
	withTempWorkspaceDir(t, workspace)
	logPath := withTempServeLog(t)
	sentinel := withTempSentinel(t)
	if err := os.WriteFile(sentinel, []byte(""), 0o644); err != nil {
		t.Fatalf("seed sentinel: %v", err)
	}

	o := &openCodeDescriptor{}
	if err := o.Start("opencode:abc"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Errorf("expected sentinel removed after Start, stat err = %v", err)
	}

	var args string
	for i := 0; i < 100; i++ {
		if b, err := os.ReadFile(argsFile); err == nil && len(b) > 0 {
			args = string(b)
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if args != "serve" {
		t.Errorf("expected stub invoked with 'serve', got %q", args)
	}

	var cwdOut string
	for i := 0; i < 100; i++ {
		if b, err := os.ReadFile(cwdFile); err == nil && len(b) > 0 {
			cwdOut = strings.TrimSpace(string(b))
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	wantWorkspace, _ := filepath.EvalSymlinks(workspace)
	gotWorkspace, _ := filepath.EvalSymlinks(cwdOut)
	if gotWorkspace != wantWorkspace {
		t.Errorf("expected opencode serve to run in %q, ran in %q", wantWorkspace, cwdOut)
	}

	// The log file must exist (opened for append before the stub ran).
	if _, err := os.Stat(logPath); err != nil {
		t.Errorf("expected serve log %q to exist: %v", logPath, err)
	}
}

// TestOpenCodeLifecycle_Start_NoSentinel_StillSucceeds asserts that Start
// does not error when the sentinel file does not already exist (the common
// case: Start after a normal boot, not after a prior Stop).
func TestOpenCodeLifecycle_Start_NoSentinel_StillSucceeds(t *testing.T) {
	t.Setenv("AGENTPOD_OPENCODE_SUPERVISED", "1")
	stubDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stubDir, "opencode"), []byte("#!/bin/sh\ntrue\n"), 0o755); err != nil {
		t.Fatalf("write opencode stub: %v", err)
	}
	t.Setenv("PATH", stubDir+":"+os.Getenv("PATH"))

	withTempWorkspaceDir(t, t.TempDir())
	withTempServeLog(t)
	withTempSentinel(t) // path set but file not created

	o := &openCodeDescriptor{}
	if err := o.Start("opencode:abc"); err != nil {
		t.Fatalf("Start with no pre-existing sentinel: unexpected error: %v", err)
	}
}

// --- Lifecycle guard: Stop/Start must refuse to act on an unsupervised host ---
//
// Detect() only advertises "lifecycle" when AGENTPOD_OPENCODE_SUPERVISED=1,
// but openCodeDescriptor structurally satisfies the Lifecycle interface
// either way (Go can't gate a method set by an env var). These tests cover
// the in-method guard that makes Stop/Start themselves refuse to run without
// the env var — so a lifecycle verb reaching this descriptor by some other
// path (a hub bug, a future direct WS caller) can't kill or spawn an
// unsupervised `opencode serve` on a bare-metal host.

// TestOpenCodeLifecycle_Stop_UnsupervisedHost_ReturnsError asserts that Stop
// refuses to run (and never touches pgrep or the sentinel) when
// AGENTPOD_OPENCODE_SUPERVISED is unset.
func TestOpenCodeLifecycle_Stop_UnsupervisedHost_ReturnsError(t *testing.T) {
	tmpDir := t.TempDir()
	argsFile := filepath.Join(tmpDir, "pgrep.args")
	writeFakePgrepPID(t, tmpDir, 99999, argsFile) // would "succeed" if ever invoked
	t.Setenv("PATH", tmpDir+":"+os.Getenv("PATH"))
	withTempSentinel(t)

	o := &openCodeDescriptor{}
	if err := o.Stop("opencode:abc"); err == nil {
		t.Fatal("expected error from Stop when AGENTPOD_OPENCODE_SUPERVISED is unset")
	}
	if readLog(t, argsFile) != "" {
		t.Error("Stop must not invoke pgrep when unsupervised")
	}
}

// TestOpenCodeLifecycle_Start_UnsupervisedHost_ReturnsError asserts that
// Start refuses to run (and never spawns opencode or removes the sentinel)
// when AGENTPOD_OPENCODE_SUPERVISED is unset.
func TestOpenCodeLifecycle_Start_UnsupervisedHost_ReturnsError(t *testing.T) {
	stubDir := t.TempDir()
	argsFile := filepath.Join(stubDir, "opencode.args")
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s' "$*" > %s
`, argsFile)
	if err := os.WriteFile(filepath.Join(stubDir, "opencode"), []byte(script), 0o755); err != nil {
		t.Fatalf("write opencode stub: %v", err)
	}
	t.Setenv("PATH", stubDir+":"+os.Getenv("PATH"))
	withTempWorkspaceDir(t, t.TempDir())
	withTempServeLog(t)
	sentinel := withTempSentinel(t)
	if err := os.WriteFile(sentinel, []byte(""), 0o644); err != nil {
		t.Fatalf("seed sentinel: %v", err)
	}

	o := &openCodeDescriptor{}
	if err := o.Start("opencode:abc"); err == nil {
		t.Fatal("expected error from Start when AGENTPOD_OPENCODE_SUPERVISED is unset")
	}
	if readLog(t, argsFile) != "" {
		t.Error("Start must not invoke opencode when unsupervised")
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Errorf("Start must not remove the sentinel when unsupervised, stat err = %v", err)
	}
}
