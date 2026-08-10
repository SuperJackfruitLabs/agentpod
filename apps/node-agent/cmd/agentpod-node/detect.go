package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

// detectCmd prints the stations detected on this host as JSON. Debug/ops smoke
// test for the descriptors — no hub connection required.
func detectCmd() {
	stations := buildRegistry(config.Config{}).DetectAll()
	b, err := json.MarshalIndent(stations, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(string(b))
}
