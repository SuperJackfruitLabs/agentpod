package descriptor

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Regression tests for #231: the opencode descriptor logged the opencode.db
// read failure on EVERY detect cycle (every 10-60s), which accounted for 83%
// of the log volume on a real node and made `apn logs` useless for diagnosis.
//
// The directory-enumeration fallback is the supported primary path in the
// provisioned images (deploy/Dockerfile.opencode deliberately omits sqlite3),
// so an unchanging failure is an expected steady state — not news. What is
// still news: the first occurrence, a change in the reason, and recovery.

// openCodeFallbackMarker is the distinctive part of the fallback log line.
const openCodeFallbackMarker = "falling back to project/ directory enumeration"

// openCodeRecoveryMarker is the distinctive part of the recovery log line.
const openCodeRecoveryMarker = "readable again"

// captureLog redirects the standard logger into a buffer for the duration of
// the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

// stubSQLite3 installs a `sqlite3` shell script at the front of PATH so the
// descriptor's DB probe has a deterministic outcome regardless of whether the
// host actually has sqlite3 installed. Call again to change its behaviour.
// Returns the stub directory so the same one can be rewritten later.
func stubSQLite3(t *testing.T, dir, script string) string {
	t.Helper()
	if dir == "" {
		dir = t.TempDir()
		t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	if err := os.WriteFile(filepath.Join(dir, "sqlite3"), []byte(script), 0o755); err != nil {
		t.Fatalf("write sqlite3 stub: %v", err)
	}
	return dir
}

// TestOpenCodeDetect_UnchangingDBFailureLogsOnce is the core #231 regression:
// repeated detect cycles under an unchanging failure must log once, not once
// per cycle. The fallback must still work.
func TestOpenCodeDetect_UnchangingDBFailureLogsOnce(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t) // no opencode.db in the fixture
	buf := captureLog(t)

	d := NewOpenCode(dataDir)
	for i := 0; i < 5; i++ {
		stations, err := d.Detect()
		if err != nil {
			t.Fatalf("Detect #%d: %v", i, err)
		}
		// The fallback is the supported path: it must keep producing the
		// station on every cycle even though we only log about it once.
		if len(stations) != 1 || *stations[0].WorkspacePath != projPath {
			t.Fatalf("Detect #%d: fallback stopped working: %+v", i, stations)
		}
	}

	if n := strings.Count(buf.String(), openCodeFallbackMarker); n != 1 {
		t.Errorf("fallback logged %d times across 5 detect cycles, want exactly 1\n--- log ---\n%s", n, buf.String())
	}
}

// TestOpenCodeDetect_ChangedDBFailureReasonLogsAgain: a different reason is a
// different fact (observed changing from "db not found" to "sqlite3 not in
// PATH" on a real host within a minute) and must be visible.
func TestOpenCodeDetect_ChangedDBFailureReasonLogsAgain(t *testing.T) {
	dataDir, _ := buildOpenCodeFixture(t)
	buf := captureLog(t)

	d := NewOpenCode(dataDir)

	// Phase 1: no opencode.db at all.
	for i := 0; i < 2; i++ {
		if _, err := d.Detect(); err != nil {
			t.Fatalf("Detect (phase 1) #%d: %v", i, err)
		}
	}
	if n := strings.Count(buf.String(), openCodeFallbackMarker); n != 1 {
		t.Fatalf("phase 1: logged %d times, want 1\n--- log ---\n%s", n, buf.String())
	}
	if !strings.Contains(buf.String(), "db not found") {
		t.Errorf("phase 1: reason should say the db is missing\n--- log ---\n%s", buf.String())
	}

	// Phase 2: the db now exists but the query fails — a different reason.
	stubSQLite3(t, "", "#!/bin/sh\nexit 5\n")
	if err := os.WriteFile(filepath.Join(dataDir, "opencode.db"), []byte("not-sqlite"), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := d.Detect(); err != nil {
			t.Fatalf("Detect (phase 2) #%d: %v", i, err)
		}
	}

	if n := strings.Count(buf.String(), openCodeFallbackMarker); n != 2 {
		t.Errorf("after the reason changed: logged %d times, want 2 (once per distinct reason)\n--- log ---\n%s", n, buf.String())
	}
	if !strings.Contains(buf.String(), "sqlite3 query failed") {
		t.Errorf("the new reason should be visible in the log\n--- log ---\n%s", buf.String())
	}
}

// TestOpenCodeDetect_RecoveryIsLogged: if the db becomes readable again after
// a fallback, that transition must not be silent — otherwise the log leaves
// the operator believing the node is still in fallback mode forever.
func TestOpenCodeDetect_RecoveryIsLogged(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)

	// A second real project that only the DB knows about, so a successful DB
	// read is observable in the station list (the dir fallback yields one).
	dbOnlyPath := filepath.Join(filepath.Dir(projPath), "dbonlyproject")
	if err := os.MkdirAll(dbOnlyPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "opencode.db"), []byte("not-sqlite"), 0o644); err != nil {
		t.Fatal(err)
	}

	buf := captureLog(t)
	stubDir := stubSQLite3(t, "", "#!/bin/sh\nexit 5\n")

	d := NewOpenCode(dataDir)
	if _, err := d.Detect(); err != nil {
		t.Fatalf("Detect (failing): %v", err)
	}
	if n := strings.Count(buf.String(), openCodeFallbackMarker); n != 1 {
		t.Fatalf("expected 1 fallback line before recovery, got %d\n--- log ---\n%s", n, buf.String())
	}

	// The db becomes readable.
	stubSQLite3(t, stubDir, "#!/bin/sh\nprintf '%s\\n%s\\n' '"+projPath+"' '"+dbOnlyPath+"'\n")

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect (recovered): %v", err)
	}
	if len(stations) != 2 {
		t.Fatalf("expected 2 stations from the db, got %d: %+v", len(stations), stations)
	}
	if n := strings.Count(buf.String(), openCodeRecoveryMarker); n != 1 {
		t.Errorf("recovery logged %d times, want exactly 1\n--- log ---\n%s", n, buf.String())
	}

	// Steady state after recovery stays quiet.
	before := buf.Len()
	for i := 0; i < 3; i++ {
		if _, err := d.Detect(); err != nil {
			t.Fatalf("Detect (steady) #%d: %v", i, err)
		}
	}
	if buf.Len() != before {
		t.Errorf("steady state after recovery logged more lines:\n%s", buf.String()[before:])
	}

	// And a later relapse is news again.
	stubSQLite3(t, stubDir, "#!/bin/sh\nexit 5\n")
	if _, err := d.Detect(); err != nil {
		t.Fatalf("Detect (relapse): %v", err)
	}
	if n := strings.Count(buf.String(), openCodeFallbackMarker); n != 2 {
		t.Errorf("relapse after recovery: got %d fallback lines, want 2\n--- log ---\n%s", n, buf.String())
	}
}
