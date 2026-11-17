//go:build !windows

package benchlaunch

import (
	"context"
	"errors"
	"os"
	"syscall"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

func lock(ctx context.Context, f *os.File) (func(), error) {
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			return nil, benchdispatch.ErrInvalid
		}
		select {
		case <-ctx.Done():
			return nil, benchdispatch.ErrPending
		case <-time.After(10 * time.Millisecond):
		}
	}
}
