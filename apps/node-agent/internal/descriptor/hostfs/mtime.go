package hostfs

import (
	"io/fs"
	"path/filepath"
	"time"
)

// NewestMtime returns the newest modification time among all regular files
// found under dir. Returns zero time if dir is absent or empty.
func NewestMtime(dir string) time.Time {
	var newest time.Time
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
		return nil
	})
	return newest
}
