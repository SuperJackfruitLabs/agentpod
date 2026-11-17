package benchlaunch

import (
	"context"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

func lock(context.Context, *os.File) (func(), error) { return nil, benchdispatch.ErrInvalid }
