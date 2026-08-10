package descriptor

import (
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Claude Code has no native ACP mode: sessions run through the external
// claude-agent-acp adapter. Every host-touching seam (PATH lookup, well-known
// path probing, `node --version`) is injected in every case below, so no test
// needs node, npx or claude installed and none spawns a process (see the Go
// test hygiene note in CLAUDE.md).

const testStubHome = "/home/pod"

// stubClaudeCodeHost replaces the descriptor's host seams. installed maps an
// executable name to the absolute path PATH would report for it; anything
// absent from the map is "not on PATH". No well-known path exists unless a
// case overrides isExecutable. nodeVersion is what `node --version` prints.
func stubClaudeCodeHost(t *testing.T, d Descriptor, installed map[string]string, nodeVersion string) *claudeCodeDescriptor {
	t.Helper()
	c, ok := d.(*claudeCodeDescriptor)
	if !ok {
		t.Fatalf("expected *claudeCodeDescriptor, got %T", d)
	}
	c.userHome = testStubHome
	c.lookPath = func(name string) (string, error) {
		if p, ok := installed[name]; ok {
			return p, nil
		}
		return "", fmt.Errorf("%s: not found in $PATH", name)
	}
	c.isExecutable = func(string) bool { return false }
	c.nodeVersion = func(string) (string, error) { return nodeVersion, nil }
	return c
}

// claudeCodeACP builds a descriptor over the standard fixture and returns it
// alongside the station key and workspace of project A.
func claudeCodeACP(t *testing.T, cfg ClaudeCodeConfig) (Descriptor, string, string) {
	t.Helper()
	home, _, projA, _ := buildClaudeCodeFixture(t)
	cfg.Home = home
	d := NewClaudeCodeFrom(cfg)
	return d, expectedClaudeKey(projA), projA
}

func acpCommander(t *testing.T, d Descriptor) ACPCommander {
	t.Helper()
	c, ok := d.(ACPCommander)
	if !ok {
		t.Fatal("claude-code descriptor must implement ACPCommander")
	}
	return c
}

// The operator's override is the escape hatch: it is used verbatim, without a
// PATH lookup that might second-guess it.
func TestClaudeCodeACPCommand_ConfigAdapterOverrideWinsVerbatim(t *testing.T) {
	d, key, projA := claudeCodeACP(t, ClaudeCodeConfig{AcpBinary: "/opt/custom/bin/claude-agent-acp"})
	stubClaudeCodeHost(t, d, map[string]string{
		"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
		"npx":              "/usr/bin/npx",
		"node":             "/usr/bin/node",
	}, "v22.14.0")

	argv, dir, _, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := []string{"/opt/custom/bin/claude-agent-acp"}; !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if dir != projA {
		t.Errorf("dir = %q, want the station's project path %q", dir, projA)
	}
}

// An installed adapter is preferred over npx: it starts instantly and can't be
// changed under us by a registry publish.
func TestClaudeCodeACPCommand_InstalledAdapterBeatsNpx(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	stubClaudeCodeHost(t, d, map[string]string{
		"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
		"npx":              "/usr/bin/npx",
		"node":             "/usr/bin/node",
	}, "v22.14.0")

	argv, _, _, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := []string{"/usr/local/bin/claude-agent-acp"}; !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want the PATH-resolved adapter %v", argv, want)
	}
}

// A pnpm/npm-global install is invisible to a systemd user service's PATH, so
// the well-known directories are probed in the documented order.
func TestClaudeCodeACPCommand_AdapterFromWellKnownPath(t *testing.T) {
	shim := filepath.Join(testStubHome, ".local", "share", "pnpm", "claude-agent-acp")
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	c := stubClaudeCodeHost(t, d, map[string]string{"node": "/usr/bin/node"}, "v22.14.0")
	c.isExecutable = func(path string) bool { return path == shim }

	argv, _, _, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := []string{shim}; !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want the pnpm shim %v", argv, want)
	}
}

func TestClaudeCodeACPCommand_ProbesWellKnownPathsInOrder(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	c := stubClaudeCodeHost(t, d, nil, "v22.14.0")
	var probed []string
	c.isExecutable = func(path string) bool {
		if filepath.Base(path) == "claude-agent-acp" {
			probed = append(probed, path)
		}
		return false
	}

	if _, _, _, err := acpCommander(t, d).ACPCommand(key); err == nil {
		t.Fatal("expected an error when nothing resolves")
	}

	want := []string{
		filepath.Join(testStubHome, ".local", "share", "pnpm", "claude-agent-acp"),
		filepath.Join(testStubHome, ".local", "bin", "claude-agent-acp"),
		"/usr/local/bin/claude-agent-acp",
		"/usr/bin/claude-agent-acp",
		"/opt/homebrew/bin/claude-agent-acp",
	}
	if !reflect.DeepEqual(probed, want) {
		t.Errorf("probed %v, want %v", probed, want)
	}
}

// The npx fallback MUST pin the version. An unpinned `npx -y <pkg>` would let
// the whole fleet's adapter change silently between two sessions.
func TestClaudeCodeACPCommand_NpxFallbackIsPinned(t *testing.T) {
	d, key, projA := claudeCodeACP(t, ClaudeCodeConfig{})
	stubClaudeCodeHost(t, d, map[string]string{
		"npx":  "/usr/bin/npx",
		"node": "/usr/bin/node",
	}, "v22.14.0")

	argv, dir, _, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	want := []string{"/usr/bin/npx", "-y", "@agentclientprotocol/claude-agent-acp@0.66.0"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if dir != projA {
		t.Errorf("dir = %q, want %q", dir, projA)
	}
}

// The npx shipped with a hand-installed node lives beside it, not on PATH.
func TestClaudeCodeACPCommand_NpxBesideConfiguredNode(t *testing.T) {
	npx := "/opt/node-22/bin/npx"
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{NodeBinary: "/opt/node-22/bin/node"})
	c := stubClaudeCodeHost(t, d, nil, "v22.14.0")
	c.isExecutable = func(path string) bool { return path == npx }

	argv, _, _, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if argv[0] != npx {
		t.Errorf("argv[0] = %q, want the npx beside the configured node %q", argv[0], npx)
	}
}

func TestClaudeCodeACPCommand_NothingResolvable(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	stubClaudeCodeHost(t, d, nil, "v22.14.0")

	_, _, _, err := acpCommander(t, d).ACPCommand(key)
	if err == nil {
		t.Fatal("expected an error rather than argv that exec would fail on later")
	}
	msg := err.Error()
	if !strings.Contains(msg, "claudeCodeAcpBinary") {
		t.Errorf("error %q must name the claudeCodeAcpBinary config key so the operator knows the fix", msg)
	}
	// The message composes into "Couldn't start the agent process — <err>".
	if strings.HasPrefix(msg, "Claude") || strings.HasSuffix(msg, ".") {
		t.Errorf("error %q must stay a lowercase sentence fragment", msg)
	}
}

// claude-agent-acp requires Node >= 22. Saying so up front beats a cryptic
// crash inside the adapter after the hub has already opened a session.
func TestClaudeCodeACPCommand_NodeVersionGate(t *testing.T) {
	cases := []struct {
		version string
		ok      bool
	}{
		{"v20.11.1", false},
		{"v21.7.3", false},
		{"v22.0.0", true},
		{"v22.14.0", true},
		{"v24.4.1", true},
	}
	for _, tc := range cases {
		t.Run(tc.version, func(t *testing.T) {
			d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
			stubClaudeCodeHost(t, d, map[string]string{
				"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
				"node":             "/usr/bin/node",
			}, tc.version)

			_, _, _, err := acpCommander(t, d).ACPCommand(key)
			if tc.ok {
				if err != nil {
					t.Fatalf("ACPCommand with node %s: %v", tc.version, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected an error for node %s", tc.version)
			}
			if !strings.Contains(err.Error(), "node 22+") || !strings.Contains(err.Error(), tc.version) {
				t.Errorf("error %q should name the requirement and the version found", err)
			}
		})
	}
}

// A node that can't be found (or won't report a version) is not a reason to
// block: an adapter may ship its own runtime. The npx path fails on npx.
func TestClaudeCodeACPCommand_UnknownNodeVersionDoesNotBlock(t *testing.T) {
	t.Run("node not installed", func(t *testing.T) {
		d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
		c := stubClaudeCodeHost(t, d, map[string]string{
			"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
		}, "v22.14.0")
		c.nodeVersion = func(string) (string, error) {
			t.Error("node --version must not run when node resolves nowhere")
			return "", nil
		}

		if _, _, _, err := acpCommander(t, d).ACPCommand(key); err != nil {
			t.Fatalf("ACPCommand: %v", err)
		}
	})

	t.Run("version unreadable", func(t *testing.T) {
		d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
		c := stubClaudeCodeHost(t, d, map[string]string{
			"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
			"node":             "/usr/bin/node",
		}, "")
		c.nodeVersion = func(string) (string, error) { return "", fmt.Errorf("exec: killed") }

		if _, _, _, err := acpCommander(t, d).ACPCommand(key); err != nil {
			t.Fatalf("ACPCommand: %v", err)
		}
	})
}

// Without CLAUDE_CODE_EXECUTABLE the adapter drives the Claude Code build
// bundled with its own SDK — so the chat session and the station's Health tab
// would be reporting two different installs.
func TestClaudeCodeACPCommand_SetsClaudeCodeExecutable(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	stubClaudeCodeHost(t, d, map[string]string{
		"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
		"claude":           "/usr/local/bin/claude",
		"node":             "/usr/bin/node",
	}, "v22.14.0")

	_, _, env, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := []string{"CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude"}; !reflect.DeepEqual(env, want) {
		t.Errorf("env = %v, want %v", env, want)
	}
}

func TestClaudeCodeACPCommand_ClaudeBinaryOverride(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{ClaudeBinary: "/opt/claude/bin/claude"})
	stubClaudeCodeHost(t, d, map[string]string{
		"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
		"claude":           "/usr/local/bin/claude",
		"node":             "/usr/bin/node",
	}, "v22.14.0")

	_, _, env, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := []string{"CLAUDE_CODE_EXECUTABLE=/opt/claude/bin/claude"}; !reflect.DeepEqual(env, want) {
		t.Errorf("env = %v, want the configured claudeCodeBinary %v", env, want)
	}
}

// No claude on the node: the variable is left unset rather than set to a path
// that doesn't exist, which the adapter would fail on immediately.
func TestClaudeCodeACPCommand_NoClaudeLeavesEnvUnset(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	stubClaudeCodeHost(t, d, map[string]string{
		"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
		"node":             "/usr/bin/node",
	}, "v22.14.0")

	_, _, env, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	for _, e := range env {
		if strings.HasPrefix(e, "CLAUDE_CODE_EXECUTABLE=") {
			t.Errorf("env %v must not set CLAUDE_CODE_EXECUTABLE when no claude was found", env)
		}
	}
}

// Nothing about the session may leak into argv or env: argv is world-readable
// via ps, and Claude Code's credentials already live on the host.
func TestClaudeCodeACPCommand_NoSecretsInCommand(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	stubClaudeCodeHost(t, d, map[string]string{
		"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
		"claude":           "/usr/local/bin/claude",
		"node":             "/usr/bin/node",
	}, "v22.14.0")

	argv, _, env, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	for _, s := range append(append([]string{}, argv...), env...) {
		lower := strings.ToLower(s)
		for _, banned := range []string{"api_key", "apikey", "token", "secret"} {
			if strings.Contains(lower, banned) {
				t.Errorf("command carries a credential-shaped value %q", s)
			}
		}
	}
}

// An unknown station has no project path, so there is nothing to resolve for.
func TestClaudeCodeACPCommand_BadKeySkipsResolution(t *testing.T) {
	d, _, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	c := stubClaudeCodeHost(t, d, map[string]string{
		"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
		"node":             "/usr/bin/node",
	}, "v22.14.0")
	c.lookPath = func(name string) (string, error) {
		t.Errorf("PATH lookup for %q must not run for an unknown station key", name)
		return "", fmt.Errorf("not found")
	}
	c.nodeVersion = func(string) (string, error) {
		t.Error("node --version must not run for an unknown station key")
		return "v22.14.0", nil
	}

	if _, _, _, err := acpCommander(t, d).ACPCommand("claude-code:deadbeef"); err == nil {
		t.Fatal("expected an error for an unknown station key")
	}
}

// NewClaudeCode (the plain constructor used by older call sites) must still
// produce a working, production-wired descriptor.
func TestNewClaudeCodeStillImplementsACPCommander(t *testing.T) {
	home, _, _, _ := buildClaudeCodeFixture(t)
	if _, ok := NewClaudeCode(home).(ACPCommander); !ok {
		t.Fatal("NewClaudeCode must return a descriptor implementing ACPCommander")
	}
}

func TestParseNodeMajor(t *testing.T) {
	cases := []struct {
		in    string
		major int
		ok    bool
	}{
		{"v22.14.0", 22, true},
		{"v22.14.0\n", 22, true},
		{" v24.0.1 ", 24, true},
		{"20.11.1", 20, true},
		{"", 0, false},
		{"vX.Y.Z", 0, false},
		{"node", 0, false},
	}
	for _, tc := range cases {
		major, ok := parseNodeMajor(tc.in)
		if ok != tc.ok || major != tc.major {
			t.Errorf("parseNodeMajor(%q) = (%d, %v), want (%d, %v)", tc.in, major, ok, tc.major, tc.ok)
		}
	}
}
