// Package gitops answers "what has changed in this workspace" by shelling out
// to the station's own git.
//
// The station's git is used rather than a Go reimplementation so the answer
// matches exactly what someone would see if they SSH'd in — same
// .gitattributes, same filters, same submodule config. The whole value of the
// capability is trusting what you are shown about a machine you are not on.
//
// This file is pure: parsing only, no exec and no filesystem, so every format
// edge can be tested against a fixture string.
package gitops

import (
	"fmt"
	"strconv"
	"strings"
)

type FileStatus string

const (
	StatusAdded       FileStatus = "added"
	StatusModified    FileStatus = "modified"
	StatusDeleted     FileStatus = "deleted"
	StatusRenamed     FileStatus = "renamed"
	StatusCopied      FileStatus = "copied"
	StatusTypeChanged FileStatus = "type-changed"
	StatusUntracked   FileStatus = "untracked"
)

// File is one changed path. Insertions/Deletions are nil for binary files and
// for untracked files (see ParsePorcelainV2).
type File struct {
	Path       string     `json:"path"`
	OldPath    *string    `json:"oldPath"`
	Status     FileStatus `json:"status"`
	Insertions *int       `json:"insertions"`
	Deletions  *int       `json:"deletions"`
	Binary     bool       `json:"binary"`
}

type Commit struct {
	SHA         string `json:"sha"`
	ShortSHA    string `json:"shortSha"`
	Subject     string `json:"subject"`
	Author      string `json:"author"`
	CommittedAt string `json:"committedAt"`
}

type PorcelainStatus struct {
	Branch   string // empty when detached
	Head     string
	Upstream string // empty when the branch tracks nothing
	Detached bool
	Files    []File
}

type NumStat struct {
	Insertions int
	Deletions  int
	Binary     bool
}

// splitZ splits NUL-terminated fields, dropping the empty tail.
func splitZ(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	parts := strings.Split(string(data), "\x00")
	if n := len(parts); n > 0 && parts[n-1] == "" {
		parts = parts[:n-1]
	}
	return parts
}

// statusFromXY maps porcelain v2's two-character staged/worktree code.
//
// The staged column is consulted first: for "AM" (added then modified) the
// change relative to HEAD is an addition, and calling it a modification would
// be wrong.
func statusFromXY(xy string) FileStatus {
	if len(xy) < 2 {
		return StatusModified
	}
	for _, c := range []byte{xy[0], xy[1]} {
		switch c {
		case 'A':
			return StatusAdded
		case 'D':
			return StatusDeleted
		case 'R':
			return StatusRenamed
		case 'C':
			return StatusCopied
		case 'T':
			return StatusTypeChanged
		case 'M':
			return StatusModified
		}
	}
	return StatusModified
}

// ParsePorcelainV2 parses `git status --porcelain=v2 --branch -z
// --untracked-files=all`.
//
// Untracked files are returned with nil line counts. Counting them would
// require `git add -N`, which writes to the index of a workspace an agent may
// be actively using; this capability never mutates the repository.
//
// The format trap: a type-2 (rename/copy) record is followed by a SECOND
// NUL-terminated field holding the old path. Treating it as the next record
// invents a phantom file and loses the rename.
func ParsePorcelainV2(data []byte) (PorcelainStatus, error) {
	var st PorcelainStatus
	fields := splitZ(data)

	for i := 0; i < len(fields); i++ {
		rec := fields[i]
		if rec == "" {
			continue
		}
		switch {
		case strings.HasPrefix(rec, "# branch.oid "):
			st.Head = strings.TrimPrefix(rec, "# branch.oid ")

		case strings.HasPrefix(rec, "# branch.head "):
			h := strings.TrimPrefix(rec, "# branch.head ")
			if h == "(detached)" {
				st.Detached = true
			} else {
				st.Branch = h
			}

		case strings.HasPrefix(rec, "# branch.upstream "):
			st.Upstream = strings.TrimPrefix(rec, "# branch.upstream ")

		case strings.HasPrefix(rec, "#"):
			// Other headers (branch.ab, stash) carry nothing we need.

		case strings.HasPrefix(rec, "1 "):
			parts := strings.SplitN(rec, " ", 9)
			if len(parts) < 9 {
				continue
			}
			st.Files = append(st.Files, File{
				Path:   parts[8],
				Status: statusFromXY(parts[1]),
			})

		case strings.HasPrefix(rec, "2 "):
			// "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>", then the
			// old path as the next NUL-terminated field.
			parts := strings.SplitN(rec, " ", 10)
			if len(parts) < 10 {
				continue
			}
			f := File{Path: parts[9], Status: statusFromXY(parts[1])}
			if i+1 < len(fields) {
				old := fields[i+1]
				f.OldPath = &old
				i++ // consume it — this is the trap
			}
			st.Files = append(st.Files, f)

		case strings.HasPrefix(rec, "u "):
			parts := strings.SplitN(rec, " ", 11)
			if len(parts) < 11 {
				continue
			}
			st.Files = append(st.Files, File{Path: parts[10], Status: StatusModified})

		case strings.HasPrefix(rec, "? "):
			st.Files = append(st.Files, File{
				Path:   strings.TrimPrefix(rec, "? "),
				Status: StatusUntracked,
			})

		case strings.HasPrefix(rec, "! "):
			// Ignored. Never shown — it is noise, not change.
		}
	}
	return st, nil
}

// ParseNumstatZ parses `git diff --numstat -z`, keyed by path (the NEW path for
// renames).
//
// Two format quirks: binary files carry "-" for both counts, and a rename
// leaves the path field EMPTY and follows the record with the old and new paths
// as two separate NUL-terminated fields, in that order.
func ParseNumstatZ(data []byte) (map[string]NumStat, error) {
	out := make(map[string]NumStat)
	fields := splitZ(data)

	for i := 0; i < len(fields); i++ {
		rec := fields[i]
		if rec == "" {
			continue
		}
		cols := strings.SplitN(rec, "\t", 3)
		if len(cols) < 3 {
			continue
		}

		var ns NumStat
		if cols[0] == "-" || cols[1] == "-" {
			ns.Binary = true
		} else {
			ins, err := strconv.Atoi(cols[0])
			if err != nil {
				return nil, fmt.Errorf("numstat: bad insertion count %q", cols[0])
			}
			del, err := strconv.Atoi(cols[1])
			if err != nil {
				return nil, fmt.Errorf("numstat: bad deletion count %q", cols[1])
			}
			ns.Insertions, ns.Deletions = ins, del
		}

		path := cols[2]
		if path == "" {
			// Rename: old path, then new path, as the next two fields.
			if i+2 < len(fields) {
				path = fields[i+2]
				i += 2
			} else {
				continue
			}
		}
		out[path] = ns
	}
	return out, nil
}

// statusFromNameStatus maps a --name-status letter, which may carry a
// similarity score ("R100").
func statusFromNameStatus(code string) FileStatus {
	if code == "" {
		return StatusModified
	}
	switch code[0] {
	case 'A':
		return StatusAdded
	case 'D':
		return StatusDeleted
	case 'R':
		return StatusRenamed
	case 'C':
		return StatusCopied
	case 'T':
		return StatusTypeChanged
	default:
		return StatusModified
	}
}

// ParseNameStatusZ parses `git diff --name-status -z`: a status field, then one
// path — or two, old then new, for renames and copies.
func ParseNameStatusZ(data []byte) ([]File, error) {
	var out []File
	fields := splitZ(data)

	for i := 0; i < len(fields); i++ {
		code := fields[i]
		if code == "" {
			continue
		}
		status := statusFromNameStatus(code)

		if status == StatusRenamed || status == StatusCopied {
			if i+2 >= len(fields) {
				break
			}
			old := fields[i+1]
			out = append(out, File{Path: fields[i+2], OldPath: &old, Status: status})
			i += 2
			continue
		}

		if i+1 >= len(fields) {
			break
		}
		out = append(out, File{Path: fields[i+1], Status: status})
		i++
	}
	return out, nil
}

// ParseCommitsZ parses `git log -z --format=%H%x1f%h%x1f%s%x1f%an%x1f%cI`.
//
// %x1f (unit separator) delimits fields because a commit subject can contain
// anything except NUL — including tabs, commas and newlines.
func ParseCommitsZ(data []byte) ([]Commit, error) {
	var out []Commit
	for _, rec := range splitZ(data) {
		rec = strings.Trim(rec, "\n")
		if rec == "" {
			continue
		}
		cols := strings.Split(rec, "\x1f")
		if len(cols) < 5 {
			continue
		}
		out = append(out, Commit{
			SHA:         cols[0],
			ShortSHA:    cols[1],
			Subject:     cols[2],
			Author:      cols[3],
			CommittedAt: cols[4],
		})
	}
	return out, nil
}
