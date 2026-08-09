package acp

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// Manager owns the set of live ACP sessions keyed both by session ID and by
// station key. All public methods are safe for concurrent use.
type Manager struct {
	mu    sync.Mutex
	byID  map[string]*Session
	byKey map[string]string // station key → session ID
}

// NewManager allocates an empty Manager.
func NewManager() *Manager {
	return &Manager{
		byID:  make(map[string]*Session),
		byKey: make(map[string]string),
	}
}

// newSessionID returns a fresh identifier of the form "acp_" + 8 random hex
// characters.
func newSessionID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return "acp_" + hex.EncodeToString(b[:])
}

// Open returns the live session for key if one already exists (idempotent),
// or spawns argv[0] with argv[1:] in dir with env appended to os.Environ().
// stdout is streamed to subscribers in chunks; stderr is discarded to a
// bounded ring (last 4 KiB) exposed via s.StderrTail() for exit reasons.
func (m *Manager) Open(key string, argv []string, dir string, env []string) (*Session, error) {
	m.mu.Lock()
	// Fast path: session already alive for this key.
	if id, ok := m.byKey[key]; ok {
		if s, ok := m.byID[id]; ok {
			m.mu.Unlock()
			return s, nil
		}
	}
	m.mu.Unlock()

	// Spawn the session outside the lock (process creation may be slow).
	id := newSessionID()
	s, err := newSession(id, argv, dir, env)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	// Double-check: another goroutine may have won the race for this key.
	if existingID, ok := m.byKey[key]; ok {
		if existing, ok := m.byID[existingID]; ok {
			m.mu.Unlock()
			// We lost the race — discard our session.
			_ = s.Close()
			return existing, nil
		}
	}
	m.byID[id] = s
	m.byKey[key] = id
	m.mu.Unlock()

	// Drop the session from the registry once the child exits so a later
	// Open for the same key spawns a fresh process instead of returning a
	// dead session.
	s.OnExit(func(string) { m.remove(id) })
	return s, nil
}

// Get looks up a session by its ID.
func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.Lock()
	s, ok := m.byID[id]
	m.mu.Unlock()
	return s, ok
}

// remove deletes id from both indexes (no-op if already gone).
func (m *Manager) remove(id string) {
	m.mu.Lock()
	delete(m.byID, id)
	for k, v := range m.byKey {
		if v == id {
			delete(m.byKey, k)
			break
		}
	}
	m.mu.Unlock()
}

// Close removes the session from both indexes and shuts down its process
// (SIGTERM → 3s grace → SIGKILL). Returns nil if no session with that ID
// exists.
func (m *Manager) Close(id string) error {
	m.mu.Lock()
	s, ok := m.byID[id]
	m.mu.Unlock()
	if !ok {
		return nil
	}
	m.remove(id)
	return s.Close()
}

// Shutdown closes every session.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.byID))
	for _, s := range m.byID {
		sessions = append(sessions, s)
	}
	m.byID = make(map[string]*Session)
	m.byKey = make(map[string]string)
	m.mu.Unlock()

	for _, s := range sessions {
		_ = s.Close()
	}
}
