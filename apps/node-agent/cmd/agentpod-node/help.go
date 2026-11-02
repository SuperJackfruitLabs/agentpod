package main

import (
	"fmt"
	"io"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/nodecli"
)

// helpRequested reports whether args' first element is a help flag. Only
// the first argument is checked (matches the flag package's own behavior
// of treating a later "-h" as an ordinary value, e.g. `apn logs -n -h`
// where -h is meant as an argument to another flag) — this keeps the gate
// from ever swallowing a command's real flags.
//
// Used to gate every command that doesn't already have its own
// flag.FlagSet (which gets -h handling for free via flag.ErrHelp) behind a
// print-help-and-exit path, checked BEFORE any side-effecting action runs
// — so `apn stop -h` can never actually stop the service, `apn run -h` can
// never connect and block, `apn service -h` can never install/uninstall,
// and so on.
func helpRequested(args []string) bool {
	return len(args) > 0 && (args[0] == "-h" || args[0] == "--help")
}

// maybeShowHelp checks helpRequested(args) and, if true, prints name's
// registered command help to out and returns true — the caller must stop
// immediately (exit 0) without doing anything else. False means args
// weren't a help request and the caller should proceed with its real work.
func maybeShowHelp(out io.Writer, name string, args []string) bool {
	if !helpRequested(args) {
		return false
	}
	fmt.Fprintln(out, nodecli.CommandHelp(name))
	return true
}
