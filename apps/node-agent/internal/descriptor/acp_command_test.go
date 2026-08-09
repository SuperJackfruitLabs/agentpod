package descriptor

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// --- OpenCode ---

func TestOpenCodeACPCommand(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	d := NewOpenCode(dataDir)

	c, ok := d.(ACPCommander)
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

	c, ok := d.(ACPCommander)
	if !ok {
		t.Fatal("opencode descriptor must implement ACPCommander")
	}

	if _, _, _, err := c.ACPCommand("opencode:deadbeef"); err == nil {
		t.Fatal("expected error for unknown station key")
	}
}

// --- Hermes ---

func TestHermesACPCommand_UsesProfileFlag(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	c, ok := d.(ACPCommander)
	if !ok {
		t.Fatal("hermes descriptor must implement ACPCommander")
	}

	argv, dir, env, err := c.ACPCommand("hermes:coder-kai")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	want := []string{"hermes", "-p", "coder-kai", "acp", "--accept-hooks"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if wantDir := filepath.Join(home, "profiles", "coder-kai"); dir != wantDir {
		t.Errorf("dir = %q, want profile workspace %q", dir, wantDir)
	}
	if env != nil {
		t.Errorf("env = %v, want nil", env)
	}
}

func TestHermesACPCommand_RootKeyOmitsProfileFlag(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	c, ok := d.(ACPCommander)
	if !ok {
		t.Fatal("hermes descriptor must implement ACPCommander")
	}

	argv, dir, _, err := c.ACPCommand("hermes")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	want := []string{"hermes", "acp", "--accept-hooks"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if dir != home {
		t.Errorf("dir = %q, want hermes home %q", dir, home)
	}
}

func TestHermesACPCommand_BadKey(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	c, ok := d.(ACPCommander)
	if !ok {
		t.Fatal("hermes descriptor must implement ACPCommander")
	}

	if _, _, _, err := c.ACPCommand("openclaw:main"); err == nil {
		t.Fatal("expected error for unrecognized key")
	}
}

// --- capability advertising ---

func TestCapabilitiesIncludeACP(t *testing.T) {
	t.Run("opencode", func(t *testing.T) {
		dataDir, _ := buildOpenCodeFixture(t)
		assertAllStationsHaveACP(t, NewOpenCode(dataDir))
	})
	t.Run("hermes", func(t *testing.T) {
		assertAllStationsHaveACP(t, NewHermes(testdataHermesHome(t)))
	})
}

func assertAllStationsHaveACP(t *testing.T, d Descriptor) {
	t.Helper()
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(stations) == 0 {
		t.Fatal("fixture produced no stations")
	}
	for _, s := range stations {
		var found bool
		for _, c := range s.Capabilities {
			if c == "acp" {
				found = true
			}
		}
		if !found {
			t.Errorf("station %q missing %q capability: %v", s.Key, "acp", s.Capabilities)
		}
	}
}

// --- Handler resolution ---

func TestHandlerACPCommand_ResolvesOpenCode(t *testing.T) {
	dataDir, projPath := buildOpenCodeFixture(t)
	reg := NewRegistry()
	reg.Register(NewOpenCode(dataDir))
	h := NewCapabilityHandler(reg)

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

func TestHandlerACPCommand_UnsupportedHarness(t *testing.T) {
	reg := NewRegistry()
	reg.Register(NewClaudeCode("/nonexistent/claude/home"))
	h := NewCapabilityHandler(reg)

	_, _, _, err := h.ACPCommand("claude-code:abcd1234")
	if err == nil {
		t.Fatal("expected error for harness without ACP support")
	}
	if !strings.Contains(err.Error(), "acp not supported") {
		t.Errorf("error should contain %q, got: %v", "acp not supported", err)
	}
}

func TestHandlerACPCommand_UnknownHarness(t *testing.T) {
	h := NewCapabilityHandler(NewRegistry())
	if _, _, _, err := h.ACPCommand("hermes:coder-kai"); err == nil {
		t.Fatal("expected error for unregistered harness")
	}
}
