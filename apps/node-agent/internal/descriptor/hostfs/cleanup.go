package hostfs

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/fsops"
)

// CleanPlanCommon enumerates cleanable paths within workspace.
//
// dirCandidates lists subdirectory names to check (e.g. ["logs", ".cache"]).
// Additionally, any *.log files directly in workspace root are included.
// Returned CleanItem.Path values are RELATIVE to workspace.
func CleanPlanCommon(workspace string, dirCandidates []string) ([]descriptor.CleanItem, error) {
	var items []descriptor.CleanItem

	for _, name := range dirCandidates {
		absPath := filepath.Join(workspace, name)
		info, err := os.Lstat(absPath)
		if err != nil || !info.IsDir() {
			continue
		}
		var size int64
		_ = filepath.WalkDir(absPath, func(_ string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			fi, err := d.Info()
			if err == nil {
				size += fi.Size()
			}
			return nil
		})
		kind := "cache"
		if name == "logs" || name == "log" {
			kind = "logs"
		} else if name == "tmp" || name == "temp" {
			kind = "tmp"
		}
		items = append(items, descriptor.CleanItem{Path: name, Size: size, Kind: kind})
	}

	// Include *.log files directly at workspace root.
	entries, err := os.ReadDir(workspace)
	if err != nil {
		if items == nil {
			items = []descriptor.CleanItem{}
		}
		return items, nil
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(strings.ToLower(name), ".log") {
			continue
		}
		fi, err := entry.Info()
		if err != nil {
			continue
		}
		items = append(items, descriptor.CleanItem{Path: name, Size: fi.Size(), Kind: "logs"})
	}

	if items == nil {
		items = []descriptor.CleanItem{}
	}
	return items, nil
}

// CleanApplyCommon implements the double-safety remove:
//
//	(a) re-jail each path to workspace (rejects escapes)
//	(b) intersect with the plan set (rejects off-plan paths)
//
// Paths failing either check are silently skipped.
// Returns the total bytes freed.
func CleanApplyCommon(workspace string, paths []string, plan []descriptor.CleanItem) (int64, error) {
	// Build a set of plan paths for O(1) lookup.
	planSet := make(map[string]bool, len(plan))
	for _, item := range plan {
		planSet[item.Path] = true
	}

	var totalRemoved int64
	for _, rel := range paths {
		// ── Safety (a): jail check ──────────────────────────────────────────
		absPath, err := fsops.Jail(workspace, rel)
		if err != nil {
			// Path escapes workspace — skip.
			continue
		}

		// ── Safety (b): plan intersection ───────────────────────────────────
		if !planSet[rel] {
			// Not in the current plan — skip.
			continue
		}

		// Compute size before removal.
		var size int64
		info, err := os.Lstat(absPath)
		if err != nil {
			continue
		}
		if info.IsDir() {
			_ = filepath.WalkDir(absPath, func(_ string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() {
					return nil
				}
				fi, e := d.Info()
				if e == nil {
					size += fi.Size()
				}
				return nil
			})
			if err := os.RemoveAll(absPath); err == nil {
				totalRemoved += size
			}
		} else {
			size = info.Size()
			if err := os.Remove(absPath); err == nil {
				totalRemoved += size
			}
		}
	}
	return totalRemoved, nil
}
