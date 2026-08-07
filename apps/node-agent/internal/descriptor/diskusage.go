package descriptor

import (
	"io/fs"
	"path/filepath"
	"sync"
	"time"
)

// Cached, asynchronous workspace disk usage.
//
// Health() must never block on a filesystem walk: a large workspace (e.g. one
// containing node_modules) can take >10s to walk, which times out the hub's
// on-demand health request and stalls the 30s health push loop. Instead,
// diskUsage returns the last computed value immediately (nil before the first
// walk completes) and refreshes stale entries in the background — at most one
// walk per directory at a time.

var diskUsageTTL = 5 * time.Minute

type diskEntry struct {
	bytes      int64
	computedAt time.Time
	refreshing bool
}

var (
	diskMu    sync.Mutex
	diskCache = map[string]*diskEntry{}
)

// diskUsage returns the cached size of dir in bytes, or nil when no walk has
// completed yet. Missing or stale entries trigger a background refresh.
func diskUsage(dir string) *int64 {
	diskMu.Lock()
	defer diskMu.Unlock()

	e, ok := diskCache[dir]
	if !ok {
		diskCache[dir] = &diskEntry{refreshing: true}
		go refreshDiskUsage(dir)
		return nil
	}

	var result *int64
	if !e.computedAt.IsZero() {
		b := e.bytes
		result = &b
	}
	if !e.refreshing && time.Since(e.computedAt) > diskUsageTTL {
		e.refreshing = true
		go refreshDiskUsage(dir)
	}
	return result
}

func refreshDiskUsage(dir string) {
	var total int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if !d.IsDir() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})

	diskMu.Lock()
	e := diskCache[dir]
	e.bytes = total
	e.computedAt = time.Now()
	e.refreshing = false
	diskMu.Unlock()
}
