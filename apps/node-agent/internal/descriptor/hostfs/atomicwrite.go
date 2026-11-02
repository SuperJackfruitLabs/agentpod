package hostfs

import (
	"io/fs"
	"os"
	"path/filepath"
)

// AtomicWriteFile writes data to path via a temp file created alongside it,
// chmod'd to perm before anything is written, then renamed into place. A
// process that dies mid-write leaves the temp file — never a half-written
// profile — and the temp file never carries a wider mode than the file it
// becomes, which matters here because data is routinely a credential.
func AtomicWriteFile(path string, data []byte, perm fs.FileMode) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-"+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	// Clean up the temp file on any failure path; a successful rename leaves
	// nothing at tmpPath to remove.
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmpPath)
		}
	}()

	if err = tmp.Chmod(perm); err != nil {
		return err
	}
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmpPath, path); err != nil {
		return err
	}
	return nil
}
