//go:build !unix

package superbench

import "os"

// The protected mode requires Unix Git/worktree and descriptor semantics.
func groupedOpen(string) (*os.File, error) { return nil, errGrouped }
