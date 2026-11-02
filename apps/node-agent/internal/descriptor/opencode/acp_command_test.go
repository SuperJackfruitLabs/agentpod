package opencode

import (
	"reflect"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// --- OpenCode ---

func TestOpenCodeACPCommand(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	c, ok := d.(descriptor.ACPCommander)
	if !ok {
		t.Fatal("opencode descriptor must implement ACPCommander")
	}

	argv, dir, env, err := c.ACPCommand(expectedOpenCodeKey(projPath))
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := []string{"opencode", "acp"}; !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if dir != projPath {
		t.Errorf("dir = %q, want station workspace %q", dir, projPath)
	}
	if env != nil {
		t.Errorf("env = %v, want nil", env)
	}
}

func TestOpenCodeACPCommand_UnknownKey(t *testing.T) {
	dataDir, _ := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	c, ok := d.(descriptor.ACPCommander)
	if !ok {
		t.Fatal("opencode descriptor must implement ACPCommander")
	}

	if _, _, _, err := c.ACPCommand("opencode:deadbeef"); err == nil {
		t.Fatal("expected error for unknown station key")
	}
}

// --- Handler resolution ---

func TestHandlerACPCommand_ResolvesOpenCode(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	reg := descriptor.NewRegistry()
	reg.Register(NewOpenCode(dataDir))
	h := descriptor.NewCapabilityHandler(reg)

	argv, dir, env, err := h.ACPCommand(expectedOpenCodeKey(projPath))
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := []string{"opencode", "acp"}; !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if dir != projPath {
		t.Errorf("dir = %q, want %q", dir, projPath)
	}
	if env != nil {
		t.Errorf("env = %v, want nil", env)
	}
}
