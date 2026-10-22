//go:build linux || darwin

package descriptor

import (
	"path/filepath"

	"golang.org/x/sys/unix"
)

// mountUsedBytes reports the used bytes of dir's filesystem, but only when dir is the root of
// its own mount (its device differs from its parent's). Anywhere else the filesystem's usage
// describes far more than dir, and ok is false.
func mountUsedBytes(dir string) (int64, bool) {
	var self, parent unix.Stat_t
	if unix.Stat(dir, &self) != nil || unix.Stat(filepath.Dir(dir), &parent) != nil {
		return 0, false
	}
	if self.Dev == parent.Dev {
		return 0, false
	}
	var st unix.Statfs_t
	if unix.Statfs(dir, &st) != nil {
		return 0, false
	}
	used := int64(st.Blocks-st.Bfree) * int64(st.Bsize)
	return used, used >= 0
}
