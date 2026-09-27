package main

import (
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

func TestSetPluginManagementPreservesNodeConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	want := config.Config{Hub: "https://hub.example", NodeID: "node_1", NodeSecret: "secret", NativeSkillActivation: true}
	if err := config.Save(path, want); err != nil {
		t.Fatal(err)
	}
	if changed, err := setPluginManagement(path, true); err != nil || !changed {
		t.Fatalf("enable = (%v, %v)", changed, err)
	}
	got, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	want.PluginManagement = true
	if got != want {
		t.Fatalf("configuration = %#v, want %#v", got, want)
	}
	if changed, err := setPluginManagement(path, true); err != nil || changed {
		t.Fatalf("second enable = (%v, %v)", changed, err)
	}
	if changed, err := setPluginManagement(path, false); err != nil || !changed {
		t.Fatalf("disable = (%v, %v)", changed, err)
	}
}
