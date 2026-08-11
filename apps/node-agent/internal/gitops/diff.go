package gitops

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fsops"
)

const (
	// DefaultMaxDiffBytes is what a caller gets when it asks for no cap.
	DefaultMaxDiffBytes = 2 << 20
	// MaxDiffBytes is the ceiling a caller cannot raise past.
	MaxDiffBytes = 8 << 20
)

type DiffResult struct {
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
}

// GetDiff returns a unified patch for one side of a changeset.
//
// side is "uncommitted" or "committed". An empty path means the whole side.
// The uncommitted whole-side patch includes untracked files, appended
// individually — "show me everything" must not quietly mean "everything git
// already tracks", which is all a bare `git diff` would give.
//
// Same truncation contract as fs.read: cap, then say so.
func GetDiff(ctx context.Context, dir, side, path, explicitBase string, maxBytes int) (DiffResult, error) {
	var res DiffResult

	if !IsRepo(ctx, dir) {
		return res, ErrNotARepo
	}
	if side != "uncommitted" && side != "committed" {
		return res, fmt.Errorf("unknown side %q (want uncommitted or committed)", side)
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxDiffBytes
	}
	if maxBytes > MaxDiffBytes {
		maxBytes = MaxDiffBytes
	}

	// path arrives from a hub request; jail it before it reaches git.
	if path != "" {
		if _, err := fsops.Jail(dir, path); err != nil {
			return res, fmt.Errorf("diff: %w", err)
		}
	}

	if side == "committed" {
		base, err := SelectBase(ctx, dir, explicitBase)
		if err != nil {
			return res, err
		}
		if base.SHA == "" {
			// An unborn HEAD has no committed work by definition.
			return DiffResult{Content: ""}, nil
		}
		args := []string{"diff", base.SHA, "HEAD"}
		if path != "" {
			args = append(args, "--", path)
		}
		out, err := run(ctx, dir, args...)
		if err != nil {
			return res, err
		}
		return capContent(string(out), maxBytes), nil
	}

	// ── uncommitted ──────────────────────────────────────────────────────────
	untracked, err := untrackedPaths(ctx, dir)
	if err != nil {
		return res, err
	}

	if path != "" {
		if untracked[filepath.ToSlash(path)] {
			out, derr := runAllowExit1(ctx, dir, "diff", "--no-index", "--", os.DevNull, path)
			if derr != nil {
				return res, derr
			}
			return capContent(string(out), maxBytes), nil
		}
		out, derr := run(ctx, dir, "diff", "HEAD", "--", path)
		if derr != nil {
			return res, derr
		}
		return capContent(string(out), maxBytes), nil
	}

	// Whole side: tracked changes, then each untracked file.
	var buf strings.Builder
	if out, derr := run(ctx, dir, "diff", "HEAD"); derr == nil {
		buf.Write(out)
	}

	// Sorted so the same workspace produces the same patch twice running — map
	// iteration order would make this output non-deterministic.
	paths := make([]string, 0, len(untracked))
	for p := range untracked {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	for _, p := range paths {
		if buf.Len() >= maxBytes {
			break
		}
		if out, derr := runAllowExit1(ctx, dir, "diff", "--no-index", "--", os.DevNull, p); derr == nil {
			buf.Write(out)
		}
	}
	return capContent(buf.String(), maxBytes), nil
}

// untrackedPaths lists untracked files, which `git diff` never shows.
func untrackedPaths(ctx context.Context, dir string) (map[string]bool, error) {
	out, err := run(ctx, dir, "status", "--porcelain=v2", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	p, err := ParsePorcelainV2(out)
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool)
	for _, f := range p.Files {
		if f.Status == StatusUntracked {
			set[filepath.ToSlash(f.Path)] = true
		}
	}
	return set, nil
}

// capContent truncates on a rune boundary. Cutting mid-rune renders as
// replacement characters in the console.
func capContent(s string, maxBytes int) DiffResult {
	if len(s) <= maxBytes {
		return DiffResult{Content: s}
	}
	cut := s[:maxBytes]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return DiffResult{Content: cut, Truncated: true}
}
