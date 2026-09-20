package acp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

var ErrEmptyArgv = errors.New("acp: empty argv")
var ErrClosed = errors.New("acp: manager shut down")

type pendingOpen struct {
	done    chan struct{}
	session *Session
	err     error
}

// Manager owns ACP children by session ID and (station key, instance). Its
// reservations cover pending starts and closing children independently of the
// addressable-session indexes. Public methods are safe for concurrent use.
type Manager struct {
	mu         sync.Mutex
	byID       map[string]*Session
	byKey      map[string]string
	pending    map[string]*pendingOpen
	finishes   map[string]func()
	closed     bool
	children   sync.WaitGroup
	workspaces *workspacegate.Coordinator
	spawn      func(string, []string, string, []string) (*Session, error)
}

// NUL separates pairs without plain-concatenation collisions. Empty instance
// preserves the legacy one-process-per-station slot.
func instanceKey(key, instance string) string { return key + "\x00" + instance }

func NewManager() *Manager { return NewManagerWithWorkspaces(workspacegate.New()) }

// NewManagerWithWorkspaces shares admission with terminals and native placement.
func NewManagerWithWorkspaces(g *workspacegate.Coordinator) *Manager {
	if g == nil {
		panic("acp: workspace coordinator required")
	}
	return &Manager{
		byID: make(map[string]*Session), byKey: make(map[string]string),
		pending: make(map[string]*pendingOpen), finishes: make(map[string]func()),
		workspaces: g, spawn: newSession,
	}
}

func newSessionID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return "acp_" + hex.EncodeToString(b[:])
}

// Open reuses the live or pending (key, instance) session, or reserves the cwd
// before spawning. Distinct instances have independent stdio. env is appended
// to os.Environ by newSession; stdout and bounded stderr retain their framing.
// Shutdown permanently closes admission and waits for pending spawns.
func (m *Manager) Open(key, instance string, argv []string, dir string, env []string) (*Session, error) {
	if len(argv) == 0 {
		return nil, ErrEmptyArgv
	}
	ikey := instanceKey(key, instance)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, ErrClosed
	}
	if s := m.byID[m.byKey[ikey]]; s != nil {
		m.mu.Unlock()
		return s, nil
	}
	if p := m.pending[ikey]; p != nil {
		m.mu.Unlock()
		<-p.done
		return p.session, p.err
	}
	p := &pendingOpen{done: make(chan struct{})}
	m.pending[ikey] = p
	// Add under the mutex that closes admission so Shutdown cannot Wait
	// before an admitted start becomes visible to the wait group.
	m.children.Add(1)
	m.mu.Unlock()
	complete := func(s *Session, err error) (*Session, error) {
		m.mu.Lock()
		p.session, p.err = s, err
		delete(m.pending, ikey)
		close(p.done)
		m.mu.Unlock()
		return s, err
	}
	lease, err := m.workspaces.Activity(context.Background(), dir)
	if err != nil {
		m.children.Done()
		return complete(nil, err)
	}
	m.mu.Lock()
	id := newSessionID()
	// Reserve IDs for pending starts as well as live children.
	for m.byID[id] != nil || m.finishes[id] != nil {
		id = newSessionID()
	}
	var finishOnce sync.Once
	finish := func() {
		finishOnce.Do(func() { m.remove(id); lease.Release(); m.children.Done() })
	}
	m.finishes[id] = finish
	closed := m.closed
	m.mu.Unlock()
	if closed {
		finish()
		return complete(nil, ErrClosed)
	}
	s, err := m.spawn(id, argv, lease.Path(), env)
	if err != nil {
		finish()
		return complete(nil, err)
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		_ = s.Close()
		finish()
		return complete(nil, ErrClosed)
	}
	m.byID[id], m.byKey[ikey] = s, id
	m.mu.Unlock()
	// Independent of user OnExit callbacks, which may block. done closes
	// after the pipe readers drain and cmd.Wait reaps the child.
	go func() { <-s.done; finish() }()
	return complete(s, nil)
}

func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.byID[id]
	return s, ok
}

func (m *Manager) remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.byID, id)
	delete(m.finishes, id)
	for key, v := range m.byKey {
		if v == id {
			delete(m.byKey, key)
			break
		}
	}
}

// Close stops reusing the instance immediately but retains its reservation
// until Close has reaped the process. Repeat callers also wait for reaping.
func (m *Manager) Close(id string) error {
	m.mu.Lock()
	s, finish := m.byID[id], m.finishes[id]
	for key, v := range m.byKey {
		if v == id {
			delete(m.byKey, key)
			break
		}
	}
	m.mu.Unlock()
	if s == nil {
		return nil
	}
	err := s.Close()
	finish()
	return err
}

// Shutdown is terminal and idempotent. It covers starts admitted before
// shutdown and children another caller is already closing.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.closed = true
	sessions := make([]string, 0, len(m.byID))
	for id := range m.byID {
		sessions = append(sessions, id)
	}
	m.mu.Unlock()
	for _, id := range sessions {
		_ = m.Close(id)
	}
	m.children.Wait()
}
