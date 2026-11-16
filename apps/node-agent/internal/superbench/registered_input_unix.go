//go:build unix

package superbench

import (
	"os"
	"syscall"
)

// The request FD is an owned, single-consumer input. Inherited stdin pipes are
// usually blocking; duplicate and enroll a nonblocking descriptor with Go's
// poller before applying deadlines. Both descriptors share that consumed pipe's
// file description; this API must never be used on an unrelated shared reader.
func registeredPipe(in *os.File) (*os.File, error) {
	fd, err := syscall.Dup(int(in.Fd()))
	if err != nil {
		return nil, ErrRegisteredFrame
	}
	syscall.CloseOnExec(fd)
	if syscall.SetNonblock(fd, true) != nil {
		_ = syscall.Close(fd)
		return nil, ErrRegisteredFrame
	}
	f := os.NewFile(uintptr(fd), "registered-input")
	if f == nil {
		_ = syscall.Close(fd)
		return nil, ErrRegisteredFrame
	}
	return f, nil
}
