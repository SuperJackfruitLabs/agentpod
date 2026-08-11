package gitops

import (
	"context"
	"strings"
)

// Base is the commit the committed side is measured against.
type Base struct {
	Ref    string `json:"ref"`
	SHA    string `json:"sha"`
	Reason string `json:"reason"` // explicit | upstream | default-branch | head
}

// SelectBase picks the base, first rule wins:
//
//	explicit        the caller passed one
//	upstream        the branch tracks something
//	default-branch  origin/HEAD resolves
//	head            nothing else did; the committed side is then empty
//
// The chosen ref is always resolved to its MERGE BASE with HEAD. Using the tip
// would show commits made on the base after the branch diverged as reversed
// changes on the station's side — work it never did.
//
// The reason is returned, not just the ref. A surprising diff on a machine you
// are not sitting at is otherwise unexplainable, and "no upstream, so you are
// seeing uncommitted work only" is a different situation from "diffed against
// your upstream".
func SelectBase(ctx context.Context, dir string, explicit string) (Base, error) {
	ref, reason := "", ""

	switch {
	case explicit != "":
		ref, reason = explicit, "explicit"

	default:
		if out, err := run(ctx, dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil {
			if u := strings.TrimSpace(string(out)); u != "" {
				ref, reason = u, "upstream"
			}
		}
		if ref == "" {
			if out, err := run(ctx, dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
				if d := strings.TrimSpace(string(out)); d != "" {
					ref, reason = d, "default-branch"
				}
			}
		}
		if ref == "" {
			ref, reason = "HEAD", "head"
		}
	}

	// An unborn HEAD (a repo with no commits) is a normal state for a new
	// station: everything is untracked and there is nothing to be based on.
	headOut, headErr := run(ctx, dir, "rev-parse", "--verify", "HEAD")
	if headErr != nil {
		return Base{Ref: ref, SHA: "", Reason: reason}, nil
	}
	head := strings.TrimSpace(string(headOut))

	if out, err := run(ctx, dir, "merge-base", ref, "HEAD"); err == nil {
		if mb := strings.TrimSpace(string(out)); mb != "" {
			return Base{Ref: ref, SHA: mb, Reason: reason}, nil
		}
	}

	// Unrelated histories, or a ref that resolves but shares no ancestor.
	if out, err := run(ctx, dir, "rev-parse", "--verify", ref+"^{commit}"); err == nil {
		return Base{Ref: ref, SHA: strings.TrimSpace(string(out)), Reason: reason}, nil
	}

	return Base{Ref: "HEAD", SHA: head, Reason: "head"}, nil
}
