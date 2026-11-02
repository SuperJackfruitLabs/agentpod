package openclaw

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// --- OpenClaw ---
//
// Both host-touching seams are overridden in every case so no test spawns or
// pgreps a process (see the Go test hygiene note in CLAUDE.md) and none depends
// on openclaw being installed on the machine running the tests.

// stubOpenClawHost replaces the two seams that would otherwise touch the host:
// the gateway liveness probe (pgrep/systemctl) and the binary resolver
// (PATH + well-known install paths). It returns the concrete descriptor so a
// case can refine either seam.
func stubOpenClawHost(t *testing.T, d descriptor.Descriptor, gatewayUp bool) *Descriptor {
	t.Helper()
	o, ok := d.(*Descriptor)
	if !ok {
		t.Fatalf("expected *openclawDescriptor, got %T", d)
	}
	o.gatewayUp = func() bool { return gatewayUp }
	o.ResolveBinary = func() (string, error) { return "openclaw", nil }
	// These tests describe a build that accepts --token-file. A build that
	// does not is refused rather than downgraded, which has its own tests.
	o.acpHelp = func(string) (string, error) {
		return "Options:\n  --token <token>\n  --token-file <path>\n  --url <url>\n", nil
	}
	return o
}

func TestOpenClawACPCommand_RootStation(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{Home: home})
	stubOpenClawHost(t, d, true)

	c, ok := d.(descriptor.ACPCommander)
	if !ok {
		t.Fatal("openclaw descriptor must implement ACPCommander")
	}
	argv, dir, env, err := c.ACPCommand("openclaw")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	want := []string{"openclaw", "acp", "--no-prefix-cwd", "--session", "agent:main:main"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if dir == "" {
		t.Error("dir must be the station workspace, got empty")
	}
	if env != nil {
		t.Errorf("env = %v, want nil (inherit)", env)
	}
}

func TestOpenClawACPCommand_AgentStation(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{Home: home, SessionLabel: "console"})
	stubOpenClawHost(t, d, true)

	argv, dir, _, err := d.(descriptor.ACPCommander).ACPCommand("openclaw:analyst")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if got := argv[len(argv)-1]; got != "agent:analyst:console" {
		t.Errorf("session key = %q, want agent:analyst:console", got)
	}
	if !strings.HasSuffix(dir, filepath.Join("agents", "analyst")) {
		t.Errorf("dir = %q, want the analyst agent workspace", dir)
	}
}

func TestOpenClawACPCommand_GatewayFlags(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{
		Home:       home,
		GatewayURL: "wss://gw.example:18789",
		TokenFile:  "/etc/agentpod/openclaw.token",
	})
	stubOpenClawHost(t, d, false) // a URL makes the local probe irrelevant

	argv, _, _, err := d.(descriptor.ACPCommander).ACPCommand("openclaw")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	joined := strings.Join(argv, " ")
	for _, want := range []string{"--url wss://gw.example:18789", "--token-file /etc/agentpod/openclaw.token"} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv %q missing %q", joined, want)
		}
	}
	for _, arg := range argv {
		if arg == "--token" {
			t.Fatal("--token must never be used: argv is world-readable via ps")
		}
	}
}

func TestOpenClawACPCommand_NoGatewayNoURL(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{Home: home})
	stubOpenClawHost(t, d, false)

	if _, _, _, err := d.(descriptor.ACPCommander).ACPCommand("openclaw"); err == nil {
		t.Fatal("expected an error when no gateway is running and no URL is configured")
	} else if !strings.Contains(err.Error(), "gateway") {
		t.Errorf("error %q should name the gateway so the console message is actionable", err)
	}
}

func TestOpenClawACPCommand_BadKey(t *testing.T) {
	d := NewOpenClawFrom(OpenClawConfig{Home: testdataOpenClawHome(t)})
	stubOpenClawHost(t, d, true)

	if _, _, _, err := d.(descriptor.ACPCommander).ACPCommand("hermes:main"); err == nil {
		t.Fatal("expected error for unrecognized key")
	}
}

// A trailing colon carries no agent name. It must be rejected before the
// session key is derived, or the bridge would be pointed at "agent::main".
func TestOpenClawACPCommand_EmptyAgentKey(t *testing.T) {
	d := NewOpenClawFrom(OpenClawConfig{Home: testdataOpenClawHome(t)})
	stubOpenClawHost(t, d, true)

	if _, _, _, err := d.(descriptor.ACPCommander).ACPCommand("openclaw:"); err == nil {
		t.Fatal("expected error for a key with an empty agent name")
	}
}
