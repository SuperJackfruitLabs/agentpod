package descriptor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestLastNLines_LargeFile verifies that a file with 5000 lines returns only
// the last 500 when n=500 and maxBytes is large enough to include all of them.
func TestLastNLines_LargeFile(t *testing.T) {
	f, err := os.CreateTemp("", "tail-test-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())

	for i := 1; i <= 5000; i++ {
		fmt.Fprintf(f, "line %d\n", i)
	}
	f.Close()

	data, err := lastNLines(f.Name(), 500, 256*1024)
	if err != nil {
		t.Fatalf("lastNLines: %v", err)
	}

	got := strings.TrimRight(string(data), "\n")
	lines := strings.Split(got, "\n")

	if len(lines) != 500 {
		t.Fatalf("want 500 lines, got %d (first=%q last=%q)", len(lines), lines[0], lines[len(lines)-1])
	}
	if lines[0] != "line 4501" {
		t.Errorf("first line: want 'line 4501', got %q", lines[0])
	}
	if lines[len(lines)-1] != "line 5000" {
		t.Errorf("last line: want 'line 5000', got %q", lines[len(lines)-1])
	}
}

// TestLastNLines_SmallFile verifies that a file with fewer lines than n
// returns all of them.
func TestLastNLines_SmallFile(t *testing.T) {
	f, err := os.CreateTemp("", "tail-test-small-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())

	for i := 1; i <= 10; i++ {
		fmt.Fprintf(f, "line %d\n", i)
	}
	f.Close()

	data, err := lastNLines(f.Name(), 500, 256*1024)
	if err != nil {
		t.Fatalf("lastNLines small: %v", err)
	}

	got := strings.TrimRight(string(data), "\n")
	lines := strings.Split(got, "\n")

	if len(lines) != 10 {
		t.Fatalf("want 10 lines, got %d", len(lines))
	}
	if lines[0] != "line 1" {
		t.Errorf("first line: want 'line 1', got %q", lines[0])
	}
	if lines[9] != "line 10" {
		t.Errorf("last line: want 'line 10', got %q", lines[9])
	}
}

// TestLastNLines_EmptyFile verifies that an empty file returns nil data with
// no error.
func TestLastNLines_EmptyFile(t *testing.T) {
	f, err := os.CreateTemp("", "tail-test-empty-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	f.Close()

	data, err := lastNLines(f.Name(), 500, 256*1024)
	if err != nil {
		t.Fatalf("lastNLines empty: %v", err)
	}
	if len(data) != 0 {
		t.Errorf("expected empty data for empty file, got %d bytes", len(data))
	}
}

// TestLastNLines_ByteCapKeepsWholeLines verifies that when maxBytes forces a
// mid-file seek, the first returned line is always a whole line (no partial
// first line) and the result does not exceed maxBytes.
func TestLastNLines_ByteCapKeepsWholeLines(t *testing.T) {
	f, err := os.CreateTemp("", "tail-test-bytecap-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())

	// Write 5000 lines (~49 KB total; each line 7-10 bytes).
	for i := 1; i <= 5000; i++ {
		fmt.Fprintf(f, "line %d\n", i)
	}
	f.Close()

	// maxBytes=1000 forces a mid-file seek, capping to ~100 lines rather than 500.
	const maxBytes int64 = 1000
	data, err := lastNLines(f.Name(), 500, maxBytes)
	if err != nil {
		t.Fatalf("lastNLines bytecap: %v", err)
	}

	// Result must not exceed maxBytes.
	if int64(len(data)) > maxBytes {
		t.Errorf("data len %d exceeds maxBytes %d", len(data), maxBytes)
	}

	// Every returned line must be a whole "line N" line.
	got := strings.TrimRight(string(data), "\n")
	lines := strings.Split(got, "\n")
	for i, l := range lines {
		if !strings.HasPrefix(l, "line ") {
			t.Errorf("line[%d] is not a whole line: %q", i, l)
		}
	}

	// Must have at least some lines.
	if len(lines) == 0 {
		t.Error("expected at least one line with maxBytes=1000")
	}
}

// --- follow-mode wait-for-first-file ---
//
// tailGlob exercises waitForLogFiles the same way production TailLogs
// implementations do: collect files matching a glob, and in follow mode wait
// for the first one to appear before emitting. It is a thin test harness
// over the real shared helper (waitForLogFiles in tail.go), not a
// reimplementation of it.
func tailGlob(ctx context.Context, pattern string, follow bool, emit func([]byte) error) error {
	collect := func() []string {
		matches, _ := filepath.Glob(pattern)
		return matches
	}
	files := collect()
	if follow {
		files = waitForLogFiles(ctx, collect)
	}
	return emitLastNLines(files, tailDefaultN, tailMaxBytes, emit)
}

// TestTailFollow_WaitsForFirstLogFile verifies that follow-mode does not
// return when the glob initially matches nothing — it must keep polling
// until a matching file appears, then emit its content. Regression test for
// the dogfooding bug (2026-08-09) where follow-mode with zero matching log
// files returned immediately, the hub closed the SSE instantly, and the
// console's Logs tab retry-looped into "Disconnected" for any harness that
// hadn't written logs yet.
func TestTailFollow_WaitsForFirstLogFile(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got := make(chan []byte, 8)
	go func() {
		_ = tailGlob(ctx, filepath.Join(dir, "*.log"), true, func(b []byte) error {
			got <- append([]byte(nil), b...)
			return nil
		})
	}()
	time.Sleep(300 * time.Millisecond) // helper is now waiting, not returned
	if err := os.WriteFile(filepath.Join(dir, "a.log"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-got:
		if !strings.Contains(string(b), "hello") {
			t.Fatalf("chunk = %q", b)
		}
	case <-ctx.Done():
		t.Fatal("no output after log file appeared — follow returned early or never polled")
	}
}

// TestTailNoFollow_EmptyDirReturnsImmediately verifies that follow==false is
// unchanged: an empty glob returns right away with no polling.
func TestTailNoFollow_EmptyDirReturnsImmediately(t *testing.T) {
	dir := t.TempDir()
	start := time.Now()
	if err := tailGlob(context.Background(), filepath.Join(dir, "*.log"), false, func([]byte) error { return nil }); err != nil {
		t.Fatalf("tailGlob: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("no-follow should return immediately")
	}
}

// TestWaitForLogFiles_ReturnsImmediatelyWhenFilesAlreadyExist verifies that
// waitForLogFiles does not wait for a poll tick when collect already has
// results — it must return on the first call.
func TestWaitForLogFiles_ReturnsImmediatelyWhenFilesAlreadyExist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.log")
	if err := os.WriteFile(path, []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	files := waitForLogFiles(context.Background(), func() []string {
		matches, _ := filepath.Glob(filepath.Join(dir, "*.log"))
		return matches
	})
	if time.Since(start) > time.Second {
		t.Fatal("waitForLogFiles should not wait when files already exist")
	}
	if len(files) != 1 || files[0] != path {
		t.Fatalf("files = %v, want [%s]", files, path)
	}
}

// TestWaitForLogFiles_StopsOnContextCancel verifies that waitForLogFiles
// gives up and returns nil once ctx is cancelled, rather than polling
// forever.
func TestWaitForLogFiles_StopsOnContextCancel(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan []string, 1)
	go func() {
		done <- waitForLogFiles(ctx, func() []string {
			matches, _ := filepath.Glob(filepath.Join(dir, "*.log"))
			return matches
		})
	}()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case files := <-done:
		if files != nil {
			t.Fatalf("files = %v, want nil after cancel", files)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("waitForLogFiles did not return after ctx cancel")
	}
}
