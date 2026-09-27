package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/selfupdate"
)

// fleetUpdate replaces THIS binary with the newest published `agentpod-fleet`.
//
// Deliberately thinner than the node agent's update: there is no service to
// restart and so no ErrRestartFailed path. A person ran this command; when it
// returns, the next invocation is the new binary.
//
// `selfupdate.Options.Binary` is the whole reason this verb is allowed to
// exist here — see cmd/agentpod-fleet/main_test.go. Without it the shared
// updater fetched a fixed `agentpod-node-…` asset, and a fleet update would
// have installed a node over the fleet binary.
func fleetUpdate(args []string) {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "fleet update [--check] [--force]")
		fs.PrintDefaults()
	}
	check := fs.Bool("check", false, "resolve and report current/latest version, no changes")
	force := fs.Bool("force", false, "update even when already on the latest version")
	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}

	res, err := selfupdate.Update(context.Background(), selfupdate.Options{
		Binary:         "agentpod-fleet",
		CurrentVersion: version,
		Force:          *force,
		CheckOnly:      *check,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "update:", err)
		os.Exit(1)
	}

	fmt.Printf("current %s, latest %s\n", res.CurrentVersion, res.LatestTag)
	switch {
	case res.Updated:
		fmt.Printf("updated to %s\n", res.LatestTag)
	case res.CurrentVersion == res.LatestTag:
		fmt.Println("up to date")
	default:
		fmt.Printf("update available: %s → %s\n", res.CurrentVersion, res.LatestTag)
	}
}
