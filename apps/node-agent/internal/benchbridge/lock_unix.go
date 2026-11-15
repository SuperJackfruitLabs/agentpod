//go:build !windows

package benchbridge

import (
	"context"
	"errors"
	"os"
	"syscall"
	"time"
)

func intentLock(ctx context.Context, f *os.File) (func(), error) {
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			return nil, ErrIntent
		}
		select {
		case <-ctx.Done():
			return nil, ErrIntent
		case <-time.After(10 * time.Millisecond):
		}
	}
}
