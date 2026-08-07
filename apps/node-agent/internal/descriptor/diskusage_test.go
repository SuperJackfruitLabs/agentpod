package descriptor

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// waitForDisk polls diskUsage until it returns a non-nil value or times out.
func waitForDisk(t *testing.T, dir string, timeout time.Duration) int64 {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if v := diskUsage(dir); v != nil {
			return *v
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("diskUsage(%s) never returned a value within %s", dir, timeout)
	return 0
}

// waitForHealthDiskBytes polls a descriptor's Health until the async disk
// cache populates DiskBytes, then returns it. Used by descriptor Health tests
// since DiskBytes is nil until the first background walk completes.
func waitForHealthDiskBytes(t *testing.T, get func() (Health, error)) int64 {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		h, err := get()
		if err != nil {
			t.Fatalf("Health: %v", err)
		}
		if h.DiskBytes != nil {
			return *h.DiskBytes
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Health.DiskBytes never populated within 2s")
	return 0
}

func TestDiskUsageFirstCallReturnsNilThenPopulates(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f.bin"), make([]byte, 1234), 0o644); err != nil {
		t.Fatal(err)
	}

	// First call must NOT block on the walk — it returns nil immediately and
	// kicks a background refresh.
	if v := diskUsage(dir); v != nil {
		t.Fatalf("first call returned %d, want nil (walk must be async)", *v)
	}

	if got := waitForDisk(t, dir, 2*time.Second); got != 1234 {
		t.Fatalf("cached disk usage = %d, want 1234", got)
	}
}

func TestDiskUsageStaleReturnsOldValueAndRefreshes(t *testing.T) {
	oldTTL := diskUsageTTL
	diskUsageTTL = time.Millisecond
	t.Cleanup(func() { diskUsageTTL = oldTTL })

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.bin"), make([]byte, 100), 0o644); err != nil {
		t.Fatal(err)
	}
	diskUsage(dir) // kick first walk
	if got := waitForDisk(t, dir, 2*time.Second); got != 100 {
		t.Fatalf("initial disk usage = %d, want 100", got)
	}

	// Grow the dir; entry is now stale (TTL 1ms). The next call must still
	// return the OLD value immediately (never block) while refreshing.
	if err := os.WriteFile(filepath.Join(dir, "b.bin"), make([]byte, 400), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond) // ensure past TTL
	if v := diskUsage(dir); v == nil || (*v != 100 && *v != 500) {
		t.Fatalf("stale call = %v, want old value 100 (or already-refreshed 500)", v)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if v := diskUsage(dir); v != nil && *v == 500 {
			return // refreshed
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("stale entry never refreshed to 500")
}
