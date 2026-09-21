package main

import (
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

func TestSetNativeSkillActivationPreservesNodeConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	want := config.Config{
		Hub: "https://hub.example", NodeID: "node_1", NodeSecret: "secret",
		CodexAcpBinary: "/opt/bin/codex-acp", NodeBinary: "/opt/bin/node",
		OpenClawStartCmd: "openclaw gateway", NativeSkillActivation: false,
	}
	if err := config.Save(path, want); err != nil {
		t.Fatal(err)
	}
	changed, err := setNativeSkillActivation(path, true)
	if err != nil || !changed {
		t.Fatalf("set enable = (%v, %v), want (true, nil)", changed, err)
	}
	got, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !got.NativeSkillActivation || got.Hub != want.Hub || got.NodeID != want.NodeID || got.NodeSecret != want.NodeSecret || got.CodexAcpBinary != want.CodexAcpBinary || got.NodeBinary != want.NodeBinary || got.OpenClawStartCmd != want.OpenClawStartCmd {
		t.Fatalf("activation changed unrelated configuration: %#v", got)
	}
	changed, err = setNativeSkillActivation(path, true)
	if err != nil || changed {
		t.Fatalf("second enable = (%v, %v), want (false, nil)", changed, err)
	}
}
