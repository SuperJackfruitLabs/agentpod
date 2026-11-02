package hermes

import (
	"path/filepath"
	"reflect"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// --- Hermes ---

func TestHermesACPCommand_UsesProfileFlag(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	c, ok := d.(descriptor.ACPCommander)
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

	c, ok := d.(descriptor.ACPCommander)
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

	c, ok := d.(descriptor.ACPCommander)
	if !ok {
		t.Fatal("hermes descriptor must implement ACPCommander")
	}

	if _, _, _, err := c.ACPCommand("openclaw:main"); err == nil {
		t.Fatal("expected error for unrecognized key")
	}
}
