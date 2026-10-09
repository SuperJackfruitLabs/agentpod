package mcpproxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// StateFileName is the proxy's state file in the node's config directory.
const StateFileName = "mcp-proxy.json"

// state is what survives a node restart: each station's secret, and the loopback address the
// proxy last bound — a session's server entry is a URL AND a secret, and a new port kills the URL
// as surely as a new secret would.
type state struct {
	Listen  string            `json:"listen,omitempty"`
	Secrets map[string]string `json:"secrets"`
}

// Store holds the proxy's secrets in an owner-only (0600) file, written by atomic rename, so a
// session opened before a node restart keeps working after it. An empty path keeps everything in
// memory, which is what a proxy without a state file has always done: new secrets per start.
//
// The file is re-read whenever it changes on disk, so a rotation made by another process
// (`apn mcp-proxy rotate`) takes effect in the running proxy at its next request, without a restart.
//
// Nothing here logs a secret, and nothing sends one anywhere: the file is the node's alone.
type Store struct {
	path string

	mu      sync.Mutex
	st      state
	loaded bool
	// seen is the file as last read or written. A rotation by another process is an atomic
	// rename, so a new inode, even when the size and the mtime's granularity cannot tell.
	seen fs.FileInfo
}

// OpenStore is a Store over path ("" = memory only). Nothing is read until it is used.
func OpenStore(path string) *Store {
	return &Store{path: path, st: state{Secrets: map[string]string{}}}
}

// refreshLocked re-reads the file when it changed since the last read. A missing file is an empty
// store. A file readable by anyone but its owner is tightened to 0600 first.
func (s *Store) refreshLocked() error {
	if s.path == "" {
		s.loaded = true
		return nil
	}
	fi, err := os.Stat(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		if !s.loaded {
			s.st = state{Secrets: map[string]string{}}
			s.loaded = true
		}
		return nil
	}
	if err != nil {
		return err
	}
	if fi.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(s.path, 0o600); err != nil {
			return fmt.Errorf("mcpproxy: tightening %s: %w", filepath.Base(s.path), err)
		}
	}
	if s.loaded && s.seen != nil && os.SameFile(s.seen, fi) && fi.ModTime().Equal(s.seen.ModTime()) && fi.Size() == s.seen.Size() {
		return nil
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var st state
	if err := json.Unmarshal(b, &st); err != nil {
		// Never quote the content: it is the secrets.
		return fmt.Errorf("mcpproxy: %s is not valid JSON", filepath.Base(s.path))
	}
	if st.Secrets == nil {
		st.Secrets = map[string]string{}
	}
	s.st, s.loaded, s.seen = st, true, fi
	return nil
}

// saveLocked writes the state atomically: a 0600 temporary in the same directory, synced, then
// renamed over the file. A crash leaves the old file or the new one, never half of either.
func (s *Store) saveLocked() error {
	if s.path == "" {
		return nil
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.st, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(s.path)+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // a no-op after the rename
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	if fi, err := os.Stat(s.path); err == nil {
		s.seen = fi
	}
	return nil
}

// Secret is a station's current secret.
func (s *Store) Secret(stationID string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refreshLocked(); err != nil {
		return "", false, err
	}
	v, ok := s.st.Secrets[stationID]
	return v, ok && v != "", nil
}

// Ensure gives each station without a secret a new one, and persists only if it had to.
func (s *Store) Ensure(stationIDs []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refreshLocked(); err != nil {
		return err
	}
	changed := false
	for _, id := range stationIDs {
		if s.st.Secrets[id] != "" {
			continue
		}
		sec, err := newSecret()
		if err != nil {
			return err
		}
		s.st.Secrets[id] = sec
		changed = true
	}
	if !changed {
		return nil
	}
	return s.saveLocked()
}

// Rotate replaces the named stations' secrets — every station in the store when none are named —
// and returns which it rotated, sorted.
func (s *Store) Rotate(stationIDs []string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refreshLocked(); err != nil {
		return nil, err
	}
	if len(stationIDs) == 0 {
		for id := range s.st.Secrets {
			stationIDs = append(stationIDs, id)
		}
	}
	var out []string
	for _, id := range stationIDs {
		sec, err := newSecret()
		if err != nil {
			return nil, err
		}
		s.st.Secrets[id] = sec
		out = append(out, id)
	}
	sort.Strings(out)
	if len(out) == 0 {
		return out, nil
	}
	return out, s.saveLocked()
}

// Listen is the address the proxy last bound, "" when none was recorded.
func (s *Store) Listen() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.refreshLocked()
	return s.st.Listen
}

// SetListen records the bound address.
func (s *Store) SetListen(addr string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refreshLocked(); err != nil {
		return err
	}
	if s.st.Listen == addr {
		return nil
	}
	s.st.Listen = addr
	return s.saveLocked()
}
