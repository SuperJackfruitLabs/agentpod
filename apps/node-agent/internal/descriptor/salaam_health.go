package descriptor

import (
	"io/fs"
	"path/filepath"
	"time"
)

// Salaam health metrics (spec 2026-10-23, C4). The daemon reports its PID over the operator
// socket; everything else the node measures the way the other descriptors do.

// salaamWorkspaceDisk is the workspace's size. A Salaam workspace is often its own filesystem
// (a loop mount on workbench), and then the filesystem's used bytes are exact and free to read.
// Otherwise it is the cached, bounded walk every other descriptor uses.
var salaamWorkspaceDisk = func(dir string) *int64 {
	if used, ok := mountUsedBytes(dir); ok {
		return &used
	}
	return diskUsage(dir)
}

// salaamActivityScanLimit bounds the fallback mtime scan: the state directory holds every
// session's transcript, and Health must not turn into an unbounded walk.
const salaamActivityScanLimit = 20000

// salaamLastActivity prefers the daemon's own last_activity_at. Without it, the newest file
// modification under the state directory stands in. The state directory's contents are only
// stat'ed, never read or exposed.
func salaamLastActivity(reported, stateDir string) *string {
	if reported != "" {
		return &reported
	}
	var newest time.Time
	seen := 0
	_ = filepath.WalkDir(stateDir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if seen++; seen > salaamActivityScanLimit {
			return filepath.SkipAll
		}
		if d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil && info.ModTime().After(newest) {
			newest = info.ModTime()
		}
		return nil
	})
	if newest.IsZero() {
		return nil
	}
	s := newest.UTC().Format(time.RFC3339)
	return &s
}
