// agentpod-bench-worker is an internal payload for benchd.run, not a dispatcher.
package main

import (
	"context"
	"fmt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
	"os"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "one private context directory required")
		os.Exit(2)
	}
	os.Clearenv()
	if err := superbench.ExecuteWorker(context.Background(), os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "worker failed; inspect retained ownership and context")
		os.Exit(1)
	}
}
