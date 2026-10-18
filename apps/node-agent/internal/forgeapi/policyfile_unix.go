//go:build !windows

package forgeapi

import (
	"os"
	"syscall"
)

// inheritOwner gives the temporary file the owner and group of the file it replaces, or, for a
// new file, the group of its directory. It is best effort: a node that is not root cannot chown,
// and then the file is the node user's, which stk reports on its next reload rather than here.
func inheritOwner(tmp string, existing os.FileInfo, dir string) {
	uid, gid := -1, -1
	if existing != nil {
		if st, ok := existing.Sys().(*syscall.Stat_t); ok {
			uid, gid = int(st.Uid), int(st.Gid)
		}
	} else if di, err := os.Stat(dir); err == nil {
		if st, ok := di.Sys().(*syscall.Stat_t); ok {
			gid = int(st.Gid)
		}
	}
	if uid == -1 && gid == -1 {
		return
	}
	_ = os.Chown(tmp, uid, gid)
}
