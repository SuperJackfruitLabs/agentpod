package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fsops"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

// Salaam read-only workspace files (spec 2026-10-23, C6; operator decision 2).
//
// Only the workspace, and only reads. The state directory (sessions, transcripts, leases, keys)
// is never served: it is outside the jail, and when it sits inside the workspace it is
// harness-private. Paths are resolved the artifact.go way (fsops.Jail, then EvalSymlinks, then
// os.OpenRoot), not with safeJoin, which does not survive a symlink. The denylist applies too.
// Errors carry the requested relative path, never a host path.

func (s *salaamDescriptor) workspaceFor(key string) (string, error) {
	if key != salaam.StationKey(s.config.Workspace) || !s.configured() {
		return "", fmt.Errorf("salaam: unknown station")
	}
	return s.config.Workspace, nil
}

// HarnessPrivate makes the state directory private whenever it lies inside the workspace.
func (s *salaamDescriptor) HarnessPrivate(key string) []string {
	if _, err := s.workspaceFor(key); err != nil {
		return []string{"."}
	}
	rel, err := filepath.Rel(s.config.Workspace, s.config.StateDir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil
	}
	return []string{rel}
}

func (s *salaamDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	ws, err := s.workspaceFor(key)
	if err != nil {
		return nil, "", false, err
	}
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}
	b, _, eof, err := ReadAt(ws, rel, 0, maxBytes, s.HarnessPrivate(key)...)
	if err != nil {
		return nil, "", false, err
	}
	return b, "", !eof, nil
}

func (s *salaamDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	ws, err := s.workspaceFor(key)
	if err != nil {
		return nil, err
	}
	if rel == "" {
		rel = "."
	}
	entries, err := s.listDir(ws, rel, s.HarnessPrivate(key))
	if err != nil {
		return nil, pathErr(rel, "read", err)
	}
	return entries, nil
}

func (s *salaamDescriptor) listDir(ws, rel string, private []string) ([]FsEntry, error) {
	if rule, ok := Denied(rel); ok {
		return nil, fmt.Errorf("%w: %s (%s)", ErrDenied, rel, rule)
	}
	if rel != "." && privateHit(rel, private) {
		return nil, fmt.Errorf("%w: %s (harness-private)", ErrDenied, rel)
	}
	target, err := fsops.Jail(ws, rel)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(ws)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return nil, err
	}
	real, err := filepath.Rel(root, resolved)
	if err != nil || real == ".." || strings.HasPrefix(real, ".."+string(filepath.Separator)) {
		return nil, fsops.ErrEscape
	}
	if rule, ok := Denied(filepath.ToSlash(real)); ok {
		return nil, fmt.Errorf("%w: %s resolves to %s (%s)", ErrDenied, rel, real, rule)
	}
	if real != "." && privateHit(real, private) {
		return nil, fmt.Errorf("%w: %s resolves to %s (harness-private)", ErrDenied, rel, real)
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	dir, err := r.Open(real)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	des, err := dir.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	out := make([]FsEntry, 0, len(des))
	for _, de := range des {
		p := de.Name()
		if real != "." {
			p = filepath.Join(real, de.Name())
		}
		if _, denied := Denied(filepath.ToSlash(p)); denied || privateHit(p, private) {
			continue
		}
		e := FsEntry{Name: de.Name(), Path: filepath.ToSlash(p), Type: "file"}
		switch {
		case de.Type()&os.ModeSymlink != 0:
			e.Type = "symlink"
		case de.IsDir():
			e.Type = "dir"
		}
		// An entry the node cannot stat (the workspace has setgid subfolders it may not read)
		// is still listed, just without size and time: one unreadable entry is not a failure.
		if info, err := r.Lstat(p); err == nil {
			mod := info.ModTime().UTC().Format(time.RFC3339)
			e.Modified = &mod
			if e.Type == "file" {
				size := info.Size()
				e.Size = &size
			}
		}
		out = append(out, e)
	}
	return out, nil
}
