package terminal

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

var ErrClosed = errors.New("terminal: manager shut down")

type pendingOpen struct {
	done    chan struct{}
	session *Session
	err     error
}

// Manager owns PTY children by session ID and station key. Workspace leases
// include starting and closing children. All public methods are concurrent-safe.
type Manager struct {
	mu         sync.Mutex
	byID       map[string]*Session
	byKey      map[string]string
	counter    int
	pending    map[string]*pendingOpen
	finishes   map[string]func()
	closed     bool
	children   sync.WaitGroup
	workspaces *workspacegate.Coordinator
	spawn      func(string, string, string, uint16, uint16) (*Session, error)
}

func NewManager() *Manager { return NewManagerWithWorkspaces(workspacegate.New()) }

// NewManagerWithWorkspaces shares admission with ACP and native publication.
func NewManagerWithWorkspaces(g *workspacegate.Coordinator) *Manager {
	if g == nil {
		panic("terminal: workspace coordinator required")
	}
	return &Manager{
		byID: make(map[string]*Session), byKey: make(map[string]string),
		pending: make(map[string]*pendingOpen), finishes: make(map[string]func()),
		workspaces: g, spawn: newSession,
	}
}

// Open reuses the live or pending session for key, or reserves cwd before
// spawning. The reservation lasts through child reaping. Empty shell defaults
// to /bin/sh. Shutdown permanently closes admission and waits for starts.
func (m *Manager) Open(key, shell, cwd string, cols, rows uint16) (*Session, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, ErrClosed
	}
	if s := m.byID[m.byKey[key]]; s != nil {
		m.mu.Unlock()
		return s, nil
	}
	if p := m.pending[key]; p != nil {
		m.mu.Unlock()
		<-p.done
		return p.session, p.err
	}
	p := &pendingOpen{done: make(chan struct{})}
	m.pending[key] = p
	m.children.Add(1)
	m.counter++
	id := fmt.Sprintf("sess-%d", m.counter)
	m.mu.Unlock()
	complete := func(s *Session, err error) (*Session, error) {
		m.mu.Lock()
		p.session, p.err = s, err
		delete(m.pending, key)
		close(p.done)
		m.mu.Unlock()
		return s, err
	}
	lease, err := m.workspaces.Activity(context.Background(), cwd)
	if err != nil {
		m.children.Done()
		return complete(nil, err)
	}
	var finishOnce sync.Once
	finish := func() {
		finishOnce.Do(func() { m.remove(id); lease.Release(); m.children.Done() })
	}
	m.mu.Lock()
	m.finishes[id] = finish
	closed := m.closed
	m.mu.Unlock()
	if closed {
		finish()
		return complete(nil, ErrClosed)
	}
	s, err := m.spawn(id, shell, lease.Path(), cols, rows)
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
	m.byID[id], m.byKey[key] = s, id
	m.mu.Unlock()
	go func() { <-s.done; finish() }()
	return complete(s, nil)
}

func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.byID[id]
	return s, ok
}

func (m *Manager) GetByKey(key string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.byID[m.byKey[key]]
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

// Close stops reusing the session immediately. Repeated calls wait for child
// reaping before releasing its reservation.
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

// Shutdown permanently closes admission and waits for pending starts, live
// children and children already being closed. It is idempotent.
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
