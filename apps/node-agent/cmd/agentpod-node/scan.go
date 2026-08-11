package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/posture"
)

// scanCmd checks this machine's agent runtimes for exposure and prints a graded
// report.
//
// Deliberately hubless: no enrollment, no account, no network. Someone who has
// never heard of AgentPod can download the binary and run this, which is the
// whole point — it is the only thing on the roadmap that reaches people who are
// not already users.
func scanCmd(args []string) {
	fs := flag.NewFlagSet("scan", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "emit the report as JSON")
	noColour := fs.Bool("no-color", false, "disable ANSI colour")
	_ = fs.Parse(args)

	// Detection is the only thing borrowed from the agent proper; the checks
	// themselves know nothing about hubs or enrollment.
	stations := buildRegistry(config.Config{}).DetectAll()

	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot determine home directory: %v\n", err)
		os.Exit(1)
	}

	// Every known harness, not just the detected ones: a credential file is a
	// risk whether or not a station is currently in use, and checking only what
	// was detected would hand a clean grade to a machine with an unused harness
	// installed and its keys world-readable.
	report := posture.Scan(context.Background(), home, posture.KnownHarnesses(), len(stations))

	if *asJSON {
		b, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println(string(b))
	} else {
		// Colour off when not a terminal, so piping to a file stays readable.
		useColour := !*noColour && isTerminal(os.Stdout)
		posture.Render(os.Stdout, report, useColour)
	}

	os.Exit(posture.ExitCode(report.Grade))
}

// isTerminal reports whether f is attached to a character device.
func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}
