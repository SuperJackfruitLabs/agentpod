//go:build windows

package mcpproxy

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
)

func lockStore(path string) (func(), error) {
	if path == "" {
		return func() {}, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	var overlap windows.Overlapped
	if err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &overlap); err != nil {
		f.Close()
		return nil, err
	}
	return func() { _ = windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlap); _ = f.Close() }, nil
}

// Windows does not expose the POSIX directory fsync used by the supported Salaam hosts.
// Retain the existing proxy's file Sync + atomic rename behavior on this platform.
func syncStoreDirectory(string) error { return nil }
