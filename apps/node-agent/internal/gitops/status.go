package gitops

import (
	"context"
	"fmt"
)

// MaxFiles caps each side's file list. One bad agent run touching every file in
// a tree must not produce an unbounded response.
const MaxFiles = 1000

type Repo struct {
	Branch   *string `json:"branch"`
	Head     *string `json:"head"`
	Detached bool    `json:"detached"`
}

type Side struct {
	Files      []File `json:"files"`
	Insertions int    `json:"insertions"`
	Deletions  int    `json:"deletions"`
}

type CommittedSide struct {
	Side
	Commits []Commit `json:"commits"`
}

type Status struct {
	Repo           Repo          `json:"repo"`
	Base           Base          `json:"base"`
	Uncommitted    Side          `json:"uncommitted"`
	Committed      CommittedSide `json:"committed"`
	TruncatedFiles bool          `json:"truncatedFiles"`
}

// GetStatus answers "what has changed in this workspace".
//
// The base affects the COMMITTED side only. Uncommitted is always the working
// tree against HEAD: changing the base changes which commits count as not yet
// on it, and cannot change what is currently unsaved on disk.
func GetStatus(ctx context.Context, dir string, explicitBase string) (Status, error) {
	var st Status

	if !IsRepo(ctx, dir) {
		return st, ErrNotARepo
	}

	base, err := SelectBase(ctx, dir, explicitBase)
	if err != nil {
		return st, err
	}
	st.Base = base

	// ── Uncommitted ──────────────────────────────────────────────────────────
	porcelainOut, err := run(ctx, dir, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all")
	if err != nil {
		return st, fmt.Errorf("status: %w", err)
	}
	p, err := ParsePorcelainV2(porcelainOut)
	if err != nil {
		return st, err
	}

	st.Repo.Detached = p.Detached
	if p.Branch != "" {
		b := p.Branch
		st.Repo.Branch = &b
	}
	if p.Head != "" {
		h := p.Head
		st.Repo.Head = &h
	}

	// Line counts for tracked changes only. Untracked files are deliberately
	// uncounted — counting them needs `git add -N`, which writes to the index.
	// An unborn HEAD has nothing to diff against, so an error here is not fatal.
	uncommittedStats := map[string]NumStat{}
	if out, nerr := run(ctx, dir, "diff", "--numstat", "-z", "HEAD"); nerr == nil {
		if m, perr := ParseNumstatZ(out); perr == nil {
			uncommittedStats = m
		}
	}
	st.Uncommitted = buildSide(p.Files, uncommittedStats)

	// ── Committed, not on the base ───────────────────────────────────────────
	st.Committed.Commits = []Commit{}
	if base.SHA != "" {
		if nameStatusOut, cerr := run(ctx, dir, "diff", "--name-status", "-z", base.SHA, "HEAD"); cerr == nil {
			files, perr := ParseNameStatusZ(nameStatusOut)
			if perr != nil {
				return st, perr
			}
			stats := map[string]NumStat{}
			if out, nerr := run(ctx, dir, "diff", "--numstat", "-z", base.SHA, "HEAD"); nerr == nil {
				if m, merr := ParseNumstatZ(out); merr == nil {
					stats = m
				}
			}
			st.Committed.Side = buildSide(files, stats)
		}

		if out, lerr := run(ctx, dir, "log", "-z",
			"--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI",
			fmt.Sprintf("%s..HEAD", base.SHA)); lerr == nil {
			if commits, perr := ParseCommitsZ(out); perr == nil && commits != nil {
				st.Committed.Commits = commits
			}
		}
	}

	if st.Uncommitted.Files == nil {
		st.Uncommitted.Files = []File{}
	}
	if st.Committed.Files == nil {
		st.Committed.Files = []File{}
	}

	st.TruncatedFiles = truncate(&st.Uncommitted) || truncate(&st.Committed.Side)
	return st, nil
}

// buildSide attaches line counts to files and totals them.
//
// A file with no numstat entry keeps nil counts: untracked files and binaries
// have no honest number, and zero would read as "no change".
func buildSide(files []File, stats map[string]NumStat) Side {
	var side Side
	side.Files = make([]File, 0, len(files))

	for _, f := range files {
		if f.Status != StatusUntracked {
			if ns, ok := stats[f.Path]; ok {
				if ns.Binary {
					f.Binary = true
				} else {
					ins, del := ns.Insertions, ns.Deletions
					f.Insertions, f.Deletions = &ins, &del
					side.Insertions += ins
					side.Deletions += del
				}
			}
		}
		side.Files = append(side.Files, f)
	}
	return side
}

// truncate caps a side's file list, reporting whether it bit. Silently
// shortening would read as "that is everything".
func truncate(s *Side) bool {
	if len(s.Files) <= MaxFiles {
		return false
	}
	s.Files = s.Files[:MaxFiles]
	return true
}
