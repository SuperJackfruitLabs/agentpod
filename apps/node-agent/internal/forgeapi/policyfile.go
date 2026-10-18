package forgeapi

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// DefaultPolicyPath is where `stk install` puts the station service's policy (root:stk, 0640,
// in a 0750 root:stk directory).
const DefaultPolicyPath = "/etc/stk/supertoolkit.yaml"

// newFileMode is the mode of a policy file the node creates. stk's install tightens the file to
// 0640 root:<stk group>; the policy holds no secret but names every brokered host, so it is
// never world-readable.
const newFileMode os.FileMode = 0o640

// readPolicyFile returns the file's bytes; a missing file is (nil, false, nil).
func readPolicyFile(path string) (data []byte, existed bool, err error) {
	data, err = os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

// writePolicyFile replaces path atomically: a temporary file in the same directory, fsynced, then
// renamed over the target. The mode is the existing file's with every world bit cleared (0640
// for a new file), and the owner and group are carried over (a new file takes its directory's
// group, which is how it ends up readable by the stk user). A reader, stk included, sees the
// old file or the new one, never half of either.
func writePolicyFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	mode := newFileMode
	// Lstat: the node runs as root and the directory can be reached by others, so a symlink at
	// the policy path is refused, not followed.
	existing, err := os.Lstat(path)
	if err == nil {
		if existing.Mode()&os.ModeSymlink != 0 || !existing.Mode().IsRegular() {
			return fmt.Errorf("refusing %s: it is not a regular file (a symlink?)", path)
		}
		mode = existing.Mode().Perm() &^ 0o007
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else {
		existing = nil
	}
	tmp, err := os.CreateTemp(dir, ".supertoolkit-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	cleanup := func() { _ = os.Remove(name) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	inheritOwner(name, existing, dir)
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(name, path); err != nil {
		cleanup()
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// restorePolicyFile puts the file back as it was: the previous bytes, or no file at all.
func restorePolicyFile(path string, prev []byte, existed bool) error {
	if !existed {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove %s: %w", path, err)
		}
		return nil
	}
	return writePolicyFile(path, prev)
}
