package descriptor

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// codexDescriptor implements Descriptor for the Codex leaf harness.
//
// Codex home layout (as known):
//
//	~/.codex/
//	  config.toml        ← model/API config
//	  sessions/          ← session history (layout may vary by version)
//
// Codex does not currently record per-project history in a stable, parseable
// format. Detect() therefore returns an empty slice and logs clearly that the
// declaration fallback must be used: leaf stations are added by the fleet
// console via declaration rather than auto-detection.
//
// If a future Codex version exposes stable project history, Detect() can be
// updated to enumerate it.
type codexDescriptor struct {
	home    string    // absolute path to ~/.codex
	logOnce sync.Once // Detect() is polled repeatedly; log the fallback note once, not every poll
}

// NewCodex returns a Descriptor for the Codex harness.
// home is the path to the ~/.codex directory. If empty it defaults to
// $HOME/.codex.
func NewCodex(home string) Descriptor {
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			userHome = "."
		}
		home = filepath.Join(userHome, ".codex")
	}
	return &codexDescriptor{home: home}
}

// Harness returns the harness identifier.
func (c *codexDescriptor) Harness() string { return "codex" }

// Detect returns an empty slice because Codex does not record per-project
// session history in a stable, machine-readable format.
//
// Leaf stations for Codex workspaces must be provided via declaration (the
// fleet-console declaration API). This function logs the fact clearly so that
// operators are aware of the fallback behaviour.
func (c *codexDescriptor) Detect() ([]Station, error) {
	if _, err := os.Stat(c.home); os.IsNotExist(err) {
		return []Station{}, nil
	}

	// Look for a sessions or history directory as a best-effort probe.
	// If nothing useful is found, log and return empty.
	sessDir := filepath.Join(c.home, "sessions")
	if _, err := os.Stat(sessDir); os.IsNotExist(err) {
		c.logOnce.Do(func() {
			log.Printf("codex: no sessions directory found at %s; "+
				"Codex does not record per-project history in a stable format — "+
				"leaf stations must be added via declaration", sessDir)
		})
		return []Station{}, nil
	}

	// A sessions dir exists but we cannot reliably map sessions to project
	// directories without knowing the internal Codex schema.
	c.logOnce.Do(func() {
		log.Printf("codex: sessions directory found at %s but project-history "+
			"mapping is not implemented; leaf stations must be added via declaration", sessDir)
	})
	return []Station{}, nil
}

// Health returns a minimal health snapshot for a codex station key.
// Since Detect() returns no stations, this is only reachable for stations
// added via declaration. DiskBytes is computed from the workspace path encoded
// in the key suffix if the descriptor can resolve it; otherwise returns an
// empty struct.
func (c *codexDescriptor) Health(key string) (Health, error) {
	// Codex stations are declaration-provided: the key encodes the workspace.
	// We cannot resolve the workspace from a key produced by Detect() (there
	// are none). Return a gracefully-degraded health with a note.
	note := "codex: station declared externally; workspace path not resolvable from key"
	return Health{Note: &note}, nil
}

// ListDir is not available for declaration-only Codex stations because the
// workspace path is not embedded in the station key.
func (c *codexDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	return nil, fmt.Errorf("codex: ListDir not supported for declaration-provided station %q", key)
}

// ReadFile is not available for declaration-only Codex stations.
func (c *codexDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	return nil, "", false, fmt.Errorf("codex: ReadFile not supported for declaration-provided station %q", key)
}

// TailLogs emits any log/session content from ~/.codex/sessions/ when the
// home directory is available. Falls back gracefully if absent.
func (c *codexDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	sessDir := filepath.Join(c.home, "sessions")
	collect := func() []string { return collectCodexLogFiles(sessDir) }
	logFiles := collect()

	if !follow {
		return emitLogFiles(logFiles, emit)
	}

	// Follow mode: wait for a log file to exist (a harness that hasn't
	// written logs yet must not close the stream immediately), then emit its
	// content and poll for appends.
	logFiles = waitForLogFiles(ctx, collect)
	if err := emitLogFiles(logFiles, emit); err != nil {
		return err
	}

	offsets := make(map[string]int64, len(logFiles))
	for _, f := range logFiles {
		if info, err := os.Stat(f); err == nil {
			offsets[f] = info.Size()
		}
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			logFiles = collectCodexLogFiles(sessDir)
			for _, path := range logFiles {
				off := offsets[path]
				n, err := emitLogFileFrom(path, off, emit)
				if err != nil {
					continue
				}
				offsets[path] = off + n
			}
		}
	}
}

// collectCodexLogFiles walks sessDir and returns all regular files, analogous
// to collectLogFiles used by the Hermes descriptor.
func collectCodexLogFiles(sessDir string) []string {
	var files []string
	_ = filepath.WalkDir(sessDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	return files
}


