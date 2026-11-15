// agentpod-bench-worker is an internal payload for benchd.run, not a dispatcher.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"runtime"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// version is stamped by the same release build as the node and fleet binaries.
// The release checksum, not a mutable installed path, pins a future dispatch.
var version = "dev"

func entry(args []string, out, errOut io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(errOut, "one private context directory required")
		return 2
	}
	if args[0] == "version" {
		fmt.Fprintf(out, "agentpod-bench-worker %s (%s/%s) %s\n", version, runtime.GOOS, runtime.GOARCH, superbench.WorkerVersion)
		return 0
	}
	os.Clearenv()
	if err := superbench.ExecuteWorker(context.Background(), args[0]); err != nil {
		fmt.Fprintln(errOut, "worker failed; inspect retained ownership and context")
		return 1
	}
	return 0
}
func main() { os.Exit(entry(os.Args[1:], os.Stdout, os.Stderr)) }
