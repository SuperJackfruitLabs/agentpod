// agentpod-bench-worker is an internal payload for benchd.run, not a dispatcher.
package main

import (
	"context"
	"errors"
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
	return entryInput(args, os.Stdin, out, errOut)
}
func entryInput(args []string, in *os.File, out, errOut io.Writer) int {
	if len(args) > 0 && args[0] == "registered-v1" {
		if len(args) != 2 || !superbench.ValidGroupedContextDigest(args[1]) {
			fmt.Fprintln(errOut, "registered worker requires one capsule digest")
			return 2
		}
		os.Clearenv()
		if err := superbench.ExecuteRegisteredWorker(context.Background(), in, out, errOut, args[1]); err != nil {
			code := "frame"
			switch {
			case errors.Is(err, superbench.ErrRegisteredLayout):
				code = "layout"
			case errors.Is(err, superbench.ErrRegisteredTask):
				code = "task"
			case errors.Is(err, superbench.ErrRegisteredResult):
				code = "result"
			}
			fmt.Fprintln(errOut, "registered worker refused: "+code)
			return 1
		}
		return 0
	}

	if len(args) == 2 {
		pair := [2]string(args)
		if superbench.ValidGroupedContextDigest(pair[1]) {
			os.Clearenv()
			if err := superbench.ExecuteGroupedWorker(context.Background(), pair[0], pair[1]); err != nil {
				fmt.Fprintln(errOut, "worker failed; inspect retained ownership and context")
				return 1
			}
			return 0
		}
	}
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
