//go:build windows

package forgeapi

import (
	"errors"
	"os"
	"path/filepath"
	"time"
)

// lockRegistry on Windows is a lock file made with O_EXCL. A lock file older than staleAfter is
// taken to belong to a dead process and is removed. (Per-station stk instances need Linux; this
// only keeps the package building and correct for a test on any OS.)
func lockRegistry(registryPath string) (unlock func(), err error) {
	const staleAfter = 30 * time.Second
	if err := os.MkdirAll(filepath.Dir(registryPath), 0o700); err != nil {
		return nil, err
	}
	path := registryPath + ".lock"
	deadline := time.Now().Add(2 * staleAfter)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = f.Close()
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if fi, serr := os.Stat(path); serr == nil && time.Since(fi.ModTime()) > staleAfter {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("registry lock is held")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
