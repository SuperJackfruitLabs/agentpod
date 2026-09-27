package descriptor

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// resetDiskCache clears the package-level cache so one test's entries cannot
// satisfy another's lookups.
func resetDiskCache(t *testing.T) {
	t.Helper()
	diskMu.Lock()
	diskCache = map[string]*diskEntry{}
	diskMu.Unlock()
}

// TestDiskUsageRefusesUnboundedRoots is the regression guard for the walk that
// never ended.
//
// ~/.claude.json records every directory Claude Code has been run from, and
// Detect turns each into a station — so running `claude` once from / or from
// $HOME made the whole filesystem a "workspace". diskUsage then walked it
// recursively every diskUsageTTL. On a real host that was 2.2M+ files per
// refresh, a walk that could not finish inside the TTL, and therefore a
// background walker that never idled: 21% of a core, permanently.
//
// A size for these paths is meaningless anyway — it describes the machine, not
// a workspace — so the answer is "unknown", not a number.
func TestDiskUsageRefusesUnboundedRoots(t *testing.T) {
	resetDiskCache(t)

	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, "f.bin"), make([]byte, 512), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ name, dir string }{
		{"filesystem root", string(filepath.Separator)},
		{"home directory", home},
		{"home with trailing separator", home + string(filepath.Separator)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if v := diskUsage(tc.dir); v != nil {
				t.Fatalf("diskUsage(%q) = %d, want nil — this path must never be walked", tc.dir, *v)
			}
			// It must STAY nil: a refused path may not quietly kick off a
			// background walk that populates the cache a moment later.
			time.Sleep(150 * time.Millisecond)
			if v := diskUsage(tc.dir); v != nil {
				t.Fatalf("diskUsage(%q) populated to %d after waiting; a refused path "+
					"must not be walked in the background either", tc.dir, *v)
			}
		})
	}
}

// TestDiskUsageWalksOrdinaryWorkspaceUnderHome asserts the refusal is exact:
// a normal project that happens to live inside $HOME is still measured. Only
// $HOME itself is refused.
func TestDiskUsageWalksOrdinaryWorkspaceUnderHome(t *testing.T) {
	resetDiskCache(t)

	home := t.TempDir()
	t.Setenv("HOME", home)
	proj := filepath.Join(home, "Projects", "app")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, "main.go"), make([]byte, 777), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := waitForDisk(t, proj, 2*time.Second); got != 777 {
		t.Fatalf("workspace under $HOME = %d, want 777; only $HOME itself is refused", got)
	}
}

// TestDiskUsageSkipsHeavyDirs asserts the walk ignores directories whose
// contents are build output or vendored code. They dominate the file count of
// a real workspace (one repo on the affected host held 132,517 files, nearly
// all of them node_modules) and none of it is the user's data.
func TestDiskUsageSkipsHeavyDirs(t *testing.T) {
	resetDiskCache(t)

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "src.go"), make([]byte, 100), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, heavy := range []string{"node_modules", ".git", "target", "dist", ".venv"} {
		sub := filepath.Join(dir, heavy, "nested")
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sub, "junk.bin"), make([]byte, 10_000), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if got := waitForDisk(t, dir, 2*time.Second); got != 100 {
		t.Fatalf("disk usage = %d, want 100 — build/vendor dirs must not be counted", got)
	}
}

// TestDiskUsageBudgetReportsUnknownNotPartial asserts that a walk which runs
// out of budget reports "unknown" rather than the partial total it had
// accumulated. A confidently wrong, far-too-small size is worse than none.
func TestDiskUsageBudgetReportsUnknownNotPartial(t *testing.T) {
	resetDiskCache(t)

	orig := diskWalkBudget
	diskWalkBudget = time.Nanosecond // every walk exceeds this immediately
	t.Cleanup(func() { diskWalkBudget = orig })

	dir := t.TempDir()
	for i := 0; i < 50; i++ {
		if err := os.WriteFile(filepath.Join(dir, string(rune('a'+i%26))+".bin"), make([]byte, 64), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	diskUsage(dir) // kick the walk
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		diskMu.Lock()
		e, ok := diskCache[dir]
		done := ok && !e.refreshing
		diskMu.Unlock()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if v := diskUsage(dir); v != nil {
		t.Fatalf("truncated walk reported %d bytes; an over-budget walk must report "+
			"unknown (nil), never the partial total", *v)
	}
}

// TestDiskUsageTruncatedWalkBacksOff asserts a walk that blew its budget is not
// retried on the normal TTL. Retrying an unwalkable tree every few minutes is
// the same permanent-walker problem in a slower form.
func TestDiskUsageTruncatedWalkBacksOff(t *testing.T) {
	resetDiskCache(t)

	origBudget, origTTL := diskWalkBudget, diskUsageTTL
	diskWalkBudget = time.Nanosecond
	diskUsageTTL = time.Millisecond // normal entries would be stale instantly
	t.Cleanup(func() { diskWalkBudget, diskUsageTTL = origBudget, origTTL })

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f.bin"), make([]byte, 64), 0o644); err != nil {
		t.Fatal(err)
	}

	diskUsage(dir)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		diskMu.Lock()
		e, ok := diskCache[dir]
		done := ok && !e.refreshing
		diskMu.Unlock()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	diskMu.Lock()
	firstAttempt := diskCache[dir].computedAt
	diskMu.Unlock()

	time.Sleep(20 * time.Millisecond) // well past the 1ms normal TTL
	diskUsage(dir)                    // must NOT kick a fresh walk

	diskMu.Lock()
	e := diskCache[dir]
	refreshing, at := e.refreshing, e.computedAt
	diskMu.Unlock()

	if refreshing || !at.Equal(firstAttempt) {
		t.Fatal("a truncated entry was retried on the normal TTL; it must back off to " +
			"diskUsageTruncatedTTL so an unwalkable tree is not re-walked every few minutes")
	}
}
