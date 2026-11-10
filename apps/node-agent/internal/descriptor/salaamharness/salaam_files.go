package salaamharness

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostfs"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

// Salaam read-only workspace files (spec 2026-10-23, C6; operator decision 2).
//
// Only the workspace, and only reads. The state directory (sessions, transcripts, leases, keys)
// is never served: it is outside the jail, and when it sits inside the workspace it is
// harness-private. Reads and listings are the guarded ones every station's files go through
// (descriptor/guardedfs.go): fsops.Jail, then EvalSymlinks, then os.OpenRoot, with the denylist.
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

// WorkspaceRoot is the root the guarded file reads serve (descriptor.WorkspaceRooter).
func (s *salaamDescriptor) WorkspaceRoot(key string) (string, error) { return s.workspaceFor(key) }

// ReadFile and ListDir are the guarded reads every station's files go through.
func (s *salaamDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	if maxBytes <= 0 {
		maxBytes = hostfs.DefaultMaxBytes
	}
	b, truncated, err := descriptor.GuardedReadFile(s, key, rel, maxBytes)
	return b, "", truncated, err
}

func (s *salaamDescriptor) ListDir(key, rel string) ([]descriptor.FsEntry, error) {
	return descriptor.GuardedListDir(s, key, rel)
}
