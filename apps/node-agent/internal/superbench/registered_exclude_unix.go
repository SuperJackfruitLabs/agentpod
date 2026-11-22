//go:build unix

package superbench

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// excludeHarnessScratch adds each harness's scratch patterns to every
// member's private info/exclude before the harness starts. The harness runs
// with its working directory in a member checkout, and a scratch file it
// leaves there (Hermes: .hermes/cache/scratch/run_tests.py, written by a
// relative path even though HERMES_HOME is outside the bench) makes the
// checkout dirty, so SuperBench refuses the checkpoint.
//
// The admin is the member's own independent Git directory (inspectRegistered
// proved it has no commondir and is owned by this payload), so the exclude is
// local to this bench member: it is never committed, never shared with another
// bench, and the repository's tracked .gitignore is never touched. Lines
// already present are not added twice, so a reused bench stays as it is.
func excludeHarnessScratch(c RegisteredCapsule) error {
	for _, m := range c.Task.Members {
		if err := appendExclude(filepath.Join(c.Task.WorkspaceRoot, ".superbench-git", m.Name), harnessScratch); err != nil {
			return ErrRegisteredLayout
		}
	}
	return nil
}

func appendExclude(admin string, patterns []string) error {
	info := filepath.Join(admin, "info")
	if err := os.Mkdir(info, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	if s, err := os.Lstat(info); err != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return ErrRegisteredLayout
	}
	fd, err := syscall.Open(filepath.Join(info, "exclude"), syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), "exclude")
	defer f.Close()
	if s, err := f.Stat(); err != nil || !s.Mode().IsRegular() || s.Size() > MaxWorker {
		return ErrRegisteredLayout
	}
	raw, err := io.ReadAll(io.LimitReader(f, MaxWorker+1))
	if err != nil || len(raw) > MaxWorker {
		return ErrRegisteredLayout
	}
	lines := map[string]bool{}
	for _, line := range bytes.Split(raw, []byte("\n")) {
		lines[string(line)] = true
	}
	var add []byte
	if len(raw) > 0 && raw[len(raw)-1] != '\n' {
		add = append(add, '\n')
	}
	for _, p := range patterns {
		if !lines[p] {
			add = append(append(add, p...), '\n')
		}
	}
	if len(add) == 0 || len(add) == 1 && add[0] == '\n' {
		return nil
	}
	if _, err = f.Seek(0, io.SeekEnd); err != nil {
		return err
	}
	if _, err = f.Write(add); err != nil {
		return err
	}
	return f.Sync()
}
