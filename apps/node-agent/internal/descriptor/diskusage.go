package descriptor

import (
	"io/fs"
	"log"
	"os"
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
//
// The walk is bounded on three axes, because an unbounded one does not merely
// cost more — it never finishes. ~/.claude.json records every directory Claude
// Code has been run from and Detect turns each into a station, so running
// `claude` once from / or from $HOME made the entire filesystem a "workspace".
// Walking that took longer than diskUsageTTL, so the refresh restarted the
// moment it ended and the walker never idled: 2.2M+ files per pass and 21% of
// a core, permanently, on a real host. The bounds are:
//
//   - unboundedRoot paths (/ and $HOME) are refused outright — their size
//     describes the machine, not a workspace, so "unknown" is the honest answer.
//   - skippedDirs (node_modules, .git, build output, vendored code) are pruned;
//     they are most of a real workspace's file count and none of its content.
//   - diskWalkBudget caps a single walk. Over budget reports unknown rather
//     than the partial total, and backs off to diskUsageTruncatedTTL so an
//     unwalkable tree is not re-walked every few minutes.

// diskUsageTTL is how long a computed size stays fresh.
var diskUsageTTL = 5 * time.Minute

// diskUsageTruncatedTTL is the (much longer) retry interval after a walk blew
// its budget. Retrying such a tree on the normal TTL is the permanent-walker
// problem again, just slower.
var diskUsageTruncatedTTL = 1 * time.Hour

// diskWalkBudget bounds one directory's walk.
var diskWalkBudget = 15 * time.Second

// diskWalkSlots caps how many workspaces are walked concurrently. Every station
// asks on the same health tick, so without this a host with 26 of them starts
// 26 simultaneous walks and saturates every core at once.
var diskWalkSlots = make(chan struct{}, 2)

// skippedDirs are directory names whose contents are never counted: build
// output, caches, and vendored dependencies. They are reproducible artefacts
// rather than the workspace's own data, and they dominate its file count.
var skippedDirs = map[string]bool{
	"node_modules": true,
	".git":         true,
	".hg":          true,
	".svn":         true,
	"target":       true,
	"dist":         true,
	"build":        true,
	".next":        true,
	".nuxt":        true,
	".turbo":       true,
	".venv":        true,
	"venv":         true,
	"__pycache__":  true,
	"vendor":       true,
	".cache":       true,
	".gradle":      true,
	".terraform":   true,
}

type diskEntry struct {
	bytes      int64
	computedAt time.Time
	refreshing bool
	// truncated records that the last walk ran out of budget, so bytes is not
	// a usable total and the retry interval is diskUsageTruncatedTTL.
	truncated bool
}

var (
	diskMu    sync.Mutex
	diskCache = map[string]*diskEntry{}

	// refusedOnce keeps the "not walking this" line to one per path, rather
	// than one per health tick forever.
	refusedOnce sync.Map
)

// unboundedRoot reports whether dir is a filesystem root or the user's home
// directory — paths whose subtree is the whole machine rather than a workspace.
//
// Exact match only: an ordinary project that happens to live inside $HOME is
// still measured. It is only $HOME itself, and /, that are refused.
func unboundedRoot(dir string) bool {
	clean := filepath.Clean(dir)
	if clean == string(filepath.Separator) {
		return true
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if clean == filepath.Clean(home) {
			return true
		}
	}
	return false
}

// diskUsage returns the cached size of dir in bytes, or nil when the size is
// not known: no walk has completed yet, the last walk ran out of budget, or dir
// is a path we refuse to walk at all.
//
// Missing or stale entries trigger a background refresh; the call never blocks
// on the filesystem.
func diskUsage(dir string) *int64 {
	if unboundedRoot(dir) {
		if _, seen := refusedOnce.LoadOrStore(dir, struct{}{}); !seen {
			log.Printf("descriptor: not measuring disk usage of %q — a filesystem root or "+
				"home directory is not a workspace; its size would describe the host", dir)
		}
		return nil
	}

	diskMu.Lock()
	defer diskMu.Unlock()

	e, ok := diskCache[dir]
	if !ok {
		diskCache[dir] = &diskEntry{refreshing: true}
		go refreshDiskUsage(dir)
		return nil
	}

	// A truncated entry has no usable total, and is retried far less often.
	ttl := diskUsageTTL
	if e.truncated {
		ttl = diskUsageTruncatedTTL
	}

	var result *int64
	if !e.computedAt.IsZero() && !e.truncated {
		b := e.bytes
		result = &b
	}
	if !e.refreshing && time.Since(e.computedAt) > ttl {
		e.refreshing = true
		go refreshDiskUsage(dir)
	}
	return result
}

// walkDiskUsage totals the regular-file bytes under dir, pruning skippedDirs
// and giving up once budget is spent. truncated reports whether it gave up.
func walkDiskUsage(dir string, budget time.Duration) (total int64, truncated bool) {
	deadline := time.Now().Add(budget)
	// Checking the clock on every entry is itself measurable on a large tree,
	// so it is sampled. Every entry counts, directories included: a tree that
	// is deep and sparse rather than wide must still be able to run out of
	// budget. The offset makes the first entry a checkpoint, so an already
	// spent budget stops the walk immediately instead of after checkEvery.
	const checkEvery = 512
	n := 0

	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if n++; n%checkEvery == 1 && time.Now().After(deadline) {
			truncated = true
			return filepath.SkipAll
		}
		if d.IsDir() {
			// Never prune the root itself, even if it is named e.g. "build".
			if path != dir && skippedDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total, truncated
}

func refreshDiskUsage(dir string) {
	diskWalkSlots <- struct{}{}
	defer func() { <-diskWalkSlots }()

	total, truncated := walkDiskUsage(dir, diskWalkBudget)
	if truncated {
		log.Printf("descriptor: disk usage of %q gave up after %s — reporting unknown; "+
			"next attempt in %s", dir, diskWalkBudget, diskUsageTruncatedTTL)
	}

	diskMu.Lock()
	e := diskCache[dir]
	e.bytes = total
	e.computedAt = time.Now()
	e.refreshing = false
	e.truncated = truncated
	diskMu.Unlock()
}
