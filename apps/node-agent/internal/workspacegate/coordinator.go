// Package workspacegate coordinates cooperating activities in one node process.
// It does not discover or stop external processes, editors or detached children.
package workspacegate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ErrBusy means an overlapping workspace already has an incompatible lease.
// Acquisition is fail-fast: callers must retry explicitly after the conflict ends.
var ErrBusy = errors.New("workspace: activity or publication in progress")

type scope struct {
	path string
	// Directory followed by ancestors: detects filesystem aliases and renames.
	dirs []os.FileInfo
}

func resolve(dir string) (scope, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return scope{}, err
	}
	canonical, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return scope{}, err
	}
	s := scope{path: canonical}
	for p := canonical; ; p = filepath.Dir(p) {
		info, err := os.Stat(p)
		if err != nil {
			return scope{}, err
		}
		if !info.IsDir() {
			return scope{}, fmt.Errorf("workspace: not a directory")
		}
		s.dirs = append(s.dirs, info)
		if p == filepath.Dir(p) {
			break
		}
	}
	return s, nil
}

func overlaps(a, b scope) bool {
	within := func(parent, child string) bool {
		rel, err := filepath.Rel(parent, child)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	if within(a.path, b.path) || within(b.path, a.path) {
		return true
	}
	for _, ancestor := range a.dirs {
		if os.SameFile(ancestor, b.dirs[0]) {
			return true
		}
	}
	for _, ancestor := range b.dirs {
		if os.SameFile(ancestor, a.dirs[0]) {
			return true
		}
	}
	return false
}

type reservation struct {
	scope     scope
	exclusive bool
}

// Coordinator admits concurrent activity or exclusive publication, never
// both in overlapping directories. Consumers must share the same instance.
// Activity lasts from before spawn through actual child reaping.
type Coordinator struct {
	mu     sync.Mutex
	next   uint64
	leases map[uint64]reservation
}

func New() *Coordinator { return &Coordinator{leases: make(map[uint64]reservation)} }

// Lease must be released on every completion and error path.
type Lease struct {
	path    string
	once    sync.Once
	release func()
}

// Path is the resolved directory to use for spawning; using the original alias
// would allow a retargeted symlink to redirect a child after admission.
func (l *Lease) Path() string { return l.path }
func (l *Lease) Release()     { l.once.Do(l.release) }

func (g *Coordinator) Activity(ctx context.Context, dir string) (*Lease, error) {
	return g.acquire(ctx, dir, false)
}

func (g *Coordinator) Exclusive(ctx context.Context, dir string) (*Lease, error) {
	return g.acquire(ctx, dir, true)
}

func (g *Coordinator) acquire(ctx context.Context, dir string, exclusive bool) (*Lease, error) {
	if g == nil {
		return nil, errors.New("workspace: coordinator required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s, err := resolve(dir)
	if err != nil {
		return nil, fmt.Errorf("workspace: resolve: %w", err)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for _, existing := range g.leases {
		if (exclusive || existing.exclusive) && overlaps(s, existing.scope) {
			return nil, ErrBusy
		}
	}
	if g.leases == nil {
		g.leases = make(map[uint64]reservation)
	}
	g.next++
	id := g.next
	g.leases[id] = reservation{scope: s, exclusive: exclusive}
	return &Lease{path: s.path, release: func() { g.mu.Lock(); delete(g.leases, id); g.mu.Unlock() }}, nil
}
