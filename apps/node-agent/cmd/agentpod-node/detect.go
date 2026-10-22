package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// loadDetectConfig reads the node's config the way `run` does, so `detect`
// reports what the running node would. A host that never enrolled has no
// config and detects with defaults.
func loadDetectConfig(path string) (config.Config, error) {
	cfg, err := config.Load(path)
	if errors.Is(err, os.ErrNotExist) {
		return config.Config{}, nil
	}
	if err != nil {
		return config.Config{}, err
	}
	return cfg, nil
}

// detectCmd prints the stations detected on this host as JSON. Debug/ops smoke
// test for the descriptors — no hub connection required.
func detectCmd() {
	stations := detectStations(config.DefaultPath(), buildRegistry)
	b, err := json.MarshalIndent(stations, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(string(b))
}

// detectStations runs detection with the config at path.
func detectStations(path string, build func(config.Config) *descriptor.Registry) []descriptor.Station {
	cfg, err := loadDetectConfig(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "warning: node config unreadable; detecting with defaults:", err)
	}
	return build(cfg).DetectAll()
}
