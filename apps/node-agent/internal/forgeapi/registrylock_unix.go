//go:build !windows

package forgeapi

import (
	"os"
	"path/filepath"
	"syscall"
)

// lockRegistry takes an exclusive advisory lock (flock on <registry>.lock) so the daemon and
// `apn forge-api setup --station` in another process never read-modify-write the registry at the
// same time. The lock file is never removed: its inode is the lock.
func lockRegistry(registryPath string) (unlock func(), err error) {
	if err := os.MkdirAll(filepath.Dir(registryPath), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(registryPath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
		if err != syscall.EINTR {
			break
		}
	}
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}
