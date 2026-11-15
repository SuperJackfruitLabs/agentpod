package benchdispatch

import (
	"context"
	"os"
)

func lock(context.Context, *os.File) (func(), error) { return nil, ErrInvalid }
