//go:build unix

package superbench

import (
	"os"
	"syscall"
)

// Nonblocking prevents a substituted FIFO from hanging admission. The caller
// verifies the opened descriptor is the exact regular file it inspected.
func groupedOpen(path string) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}
