// Command agentpod-fleet acts on an AgentPod fleet as a principal — a person or
// an agent — rather than as the machine it runs on.
//
// It is deliberately a separate program from agentpod-node. That binary is a
// resident daemon enrolled onto a host; this one is an interactive client run
// from laptops, CI and worker sandboxes. They share a repository and nothing
// else: different lifecycle, different audience, different install path.
//
// The separation is structural, not merely conventional. This binary links no
// node code, so the rule that a fleet command never reads a node's credential
// holds by construction rather than by discipline.
package main

import (
	"fmt"
	"os"
	"runtime"
)

// version is the binary's build version. Overridden at link time via:
//
//	-ldflags "-X main.version=<tag>"
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		fmt.Println(helpText(version))
		os.Exit(0)
	}
	switch os.Args[1] {
	case "help", "-h", "--help":
		fmt.Println(helpText(version))
	case "version":
		fmt.Printf("agentpod-fleet %s %s/%s\n", version, runtime.GOOS, runtime.GOARCH)
	default:
		fleetCmd(os.Args[1:])
	}
}
