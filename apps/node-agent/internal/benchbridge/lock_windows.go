//go:build windows

package benchbridge

import (
	"context"
	"os"
)

func intentLock(context.Context, *os.File) (func(), error) { return nil, ErrIntent }
