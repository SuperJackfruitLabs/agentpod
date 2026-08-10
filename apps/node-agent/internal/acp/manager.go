package acp

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
)

// ErrEmptyArgv is returned by Open when argv has no command to run.
var ErrEmptyArgv = errors.New("acp: empty argv")

// Manager owns the set of live ACP sessions keyed both by session ID and by
// the (station key, instance) pair. All public methods are safe for concurrent
// use.
type Manager struct {
	mu    sync.Mutex
	byID  map[string]*Session
	byKey map[string]string // instanceKey(key, instance) → session ID
}

// instanceKey encodes the (station key, instance) pair as one map key. NUL
// cannot appear in either half (station keys are "harness:id", instances are
// hub-chosen identifiers), so the pairs can never flatten onto each other the
// way plain concatenation would collapse ("a","bc") and ("ab","c"). An empty
// instance is a distinct pair of its own — that is the legacy
// one-process-per-key slot an older hub keeps re-opening.
func instanceKey(key, instance string) string {
	return key + "\x00" + instance
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

// Open returns the live session for the (key, instance) pair if one already
// exists (idempotent), or spawns argv[0] with argv[1:] in dir with env appended
// to os.Environ(). stdout is streamed to subscribers in chunks; stderr is
// discarded to a bounded ring (last 4 KiB) exposed via s.StderrTail() for exit
// reasons.
//
// instance discriminates concurrent sessions on one station: each distinct
// instance gets its own child, so two hub sessions never read each other's
// JSON-RPC traffic. An empty instance keeps the pre-instance behaviour
// (idempotent by station key alone), which is what an older hub sends.
func (m *Manager) Open(key, instance string, argv []string, dir string, env []string) (*Session, error) {
	if len(argv) == 0 {
		return nil, ErrEmptyArgv
	}
	ikey := instanceKey(key, instance)

	m.mu.Lock()
	// Fast path: session already alive for this pair.
	if id, ok := m.byKey[ikey]; ok {
		if s, ok := m.byID[id]; ok {
			m.mu.Unlock()
			return s, nil
		}
	}
	// Pick an ID that is not in use, retrying on (astronomically unlikely)
	// random collision.
	id := newSessionID()
	for {
		if _, taken := m.byID[id]; !taken {
			break
		}
		id = newSessionID()
	}
	m.mu.Unlock()

	// Spawn the session outside the lock (process creation may be slow).
	s, err := newSession(id, argv, dir, env)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	// Double-check: another goroutine may have won the race for this pair.
	if existingID, ok := m.byKey[ikey]; ok {
		if existing, ok := m.byID[existingID]; ok {
			m.mu.Unlock()
			// We lost the race — discard our session.
			_ = s.Close()
			return existing, nil
		}
	}
	m.byID[id] = s
	m.byKey[ikey] = id
	m.mu.Unlock()

	// Drop the session from the registry once the child exits so a later
	// Open for the same pair spawns a fresh process instead of returning a
	// dead session. Only this pair's entry goes — siblings on the same station
	// key keep running.
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

// remove deletes id from both indexes (no-op if already gone). A session ID is
// mapped from at most one (key, instance) pair, so the reverse scan can stop at
// the first hit and leaves every sibling pair on the same station key intact.
func (m *Manager) remove(id string) {
	m.mu.Lock()
	delete(m.byID, id)
	for ikey, v := range m.byKey {
		if v == id {
			delete(m.byKey, ikey)
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
