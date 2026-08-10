package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Claude Code has no native ACP mode: sessions run through the external
// claude-agent-acp adapter. Every host-touching seam (PATH lookup, well-known
// path probing, `node --version`) is injected in every case below, so no test
// needs node, npx or claude installed and none spawns a process (see the Go
// test hygiene note in CLAUDE.md).

const (
	testStubHome = "/home/pod"
	testStubPath = "/usr/local/bin:/usr/bin:/bin"
)

// stubClaudeCodeHost replaces the descriptor's host seams. installed maps an
// executable name to the absolute path PATH would report for it; anything
// absent from the map is "not on PATH". No well-known path exists unless a
// case overrides isExecutable. nodeVersion is what `node --version` prints, for
// every candidate — a case that needs one answer per node path replaces the
// seam itself.
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
	c.getenv = func(name string) string {
		if name == "PATH" {
			return testStubPath
		}
		return ""
	}
	return c
}

// nodeVersions builds a nodeVersion seam that answers per node path; a path
// absent from the map behaves like a binary that can't be run.
func nodeVersions(versions map[string]string) func(string) (string, error) {
	return func(nodePath string) (string, error) {
		if v, ok := versions[nodePath]; ok {
			return v, nil
		}
		return "", fmt.Errorf("fork/exec %s: no such file or directory", nodePath)
	}
}

// pathEntry returns the PATH= entry from env, or "".
func pathEntry(env []string) string {
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") {
			return strings.TrimPrefix(e, "PATH=")
		}
	}
	return ""
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

// The gate must judge the runtime the adapter will ACTUALLY run under. On the
// host nodeBinary exists for — an old node first on the service's PATH, a good
// one installed out of the way — a PATH-first npx lookup would green-light v22
// and then start the adapter under v18: the exact crash the gate prevents, now
// with a passing pre-check.
func TestClaudeCodeACPCommand_ConfiguredNodeBeatsOlderPathNode(t *testing.T) {
	const (
		configuredDir = "/opt/node-22/bin"
		configured    = configuredDir + "/node"
	)
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{NodeBinary: configured})
	c := stubClaudeCodeHost(t, d, map[string]string{
		"node": "/usr/bin/node",
		"npx":  "/usr/bin/npx", // node 18's npx
	}, "")
	c.nodeVersion = nodeVersions(map[string]string{
		configured:      "v22.14.0",
		"/usr/bin/node": "v18.19.0",
	})
	c.isExecutable = func(path string) bool { return path == configuredDir+"/npx" }

	argv, _, env, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := configuredDir + "/npx"; argv[0] != want {
		t.Errorf("argv[0] = %q, want the configured runtime's npx %q — PATH's npx belongs to node 18", argv[0], want)
	}
	// Belt and braces: npx execs `node` through PATH, so the configured runtime
	// must also come first there.
	if got := pathEntry(env); !strings.HasPrefix(got, configuredDir+string(os.PathListSeparator)) {
		t.Errorf("PATH = %q, want the configured runtime's dir %q first", got, configuredDir)
	}
	if got := pathEntry(env); !strings.HasSuffix(got, testStubPath) {
		t.Errorf("PATH = %q must PREPEND to the inherited PATH %q, not replace it", got, testStubPath)
	}
}

// The mirror case must not refuse: nodeBinary exists to supply a good runtime,
// never to downgrade a working one. A stale override with node 22 on PATH is an
// operator's leftover config, not a reason to refuse a session that works.
func TestClaudeCodeACPCommand_StaleConfiguredNodeDoesNotRefuse(t *testing.T) {
	const configured = "/opt/node-18/bin/node"
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{NodeBinary: configured})
	c := stubClaudeCodeHost(t, d, map[string]string{
		"node":             "/usr/bin/node",
		"npx":              "/usr/bin/npx",
		"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
	}, "")
	c.nodeVersion = nodeVersions(map[string]string{
		configured:      "v18.19.0",
		"/usr/bin/node": "v22.14.0",
	})

	argv, _, env, err := acpCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("a node 22 on PATH must carry the session: %v", err)
	}
	if want := []string{"/usr/local/bin/claude-agent-acp"}; !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if got := pathEntry(env); strings.Contains(got, "/opt/node-18/bin") {
		t.Errorf("PATH = %q must not put the stale configured runtime ahead of the node 22 being used", got)
	}
}

// A mistyped nodeBinary must degrade to a check, not to no check: `locate`
// returns an override unexamined, so without a fallback the version probe fails
// and the gate silently passes whatever is really on the host.
func TestClaudeCodeACPCommand_UnusableNodeBinaryFallsBackToPath(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{NodeBinary: "/opt/node-22/bni/node"})
	c := stubClaudeCodeHost(t, d, map[string]string{
		"node":             "/usr/bin/node",
		"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
	}, "")
	c.nodeVersion = nodeVersions(map[string]string{"/usr/bin/node": "v20.11.1"})

	_, _, _, err := acpCommander(t, d).ACPCommand(key)
	if err == nil {
		t.Fatal("a typo'd nodeBinary must not disable the version gate")
	}
	if !strings.Contains(err.Error(), "v20.11.1") {
		t.Errorf("error %q should report the node actually found on PATH", err)
	}
}

// An explicitly configured adapter takes responsibility for its own runtime: it
// may be a wrapper that execs a bundled node, in which case the host's node is
// irrelevant. Refusing there would contradict the same rule that lets a host
// with NO node through.
func TestClaudeCodeACPCommand_NodeGateAppliesPerAdapterSource(t *testing.T) {
	t.Run("explicit adapter override is exempt", func(t *testing.T) {
		d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{AcpBinary: "/opt/wrapper/claude-agent-acp"})
		stubClaudeCodeHost(t, d, map[string]string{"node": "/usr/bin/node"}, "v18.19.0")

		argv, _, _, err := acpCommander(t, d).ACPCommand(key)
		if err != nil {
			t.Fatalf("a configured adapter must not be gated on the host's node: %v", err)
		}
		if want := []string{"/opt/wrapper/claude-agent-acp"}; !reflect.DeepEqual(argv, want) {
			t.Errorf("argv = %v, want %v", argv, want)
		}
	})

	t.Run("resolved adapter is gated", func(t *testing.T) {
		d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
		stubClaudeCodeHost(t, d, map[string]string{
			"claude-agent-acp": "/usr/local/bin/claude-agent-acp",
			"node":             "/usr/bin/node",
		}, "v18.19.0")

		if _, _, _, err := acpCommander(t, d).ACPCommand(key); err == nil {
			t.Fatal("an adapter we chose ourselves runs under the host's node, so it must be gated")
		}
	})

	t.Run("npx fallback is gated", func(t *testing.T) {
		d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
		stubClaudeCodeHost(t, d, map[string]string{
			"npx":  "/usr/bin/npx",
			"node": "/usr/bin/node",
		}, "v18.19.0")

		if _, _, _, err := acpCommander(t, d).ACPCommand(key); err == nil {
			t.Fatal("the npx fallback runs under the host's node, so it must be gated")
		}
	})
}

// Both problems at once: the runtime is reported, because it is the more
// fundamental one — installing an adapter wouldn't make node 20 work.
func TestClaudeCodeACPCommand_OldNodeReportedBeforeMissingAdapter(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	stubClaudeCodeHost(t, d, map[string]string{"node": "/usr/bin/node"}, "v20.11.1")

	_, _, _, err := acpCommander(t, d).ACPCommand(key)
	if err == nil {
		t.Fatal("expected an error when the node is too old and no adapter resolves")
	}
	if !strings.Contains(err.Error(), "node 22+") {
		t.Errorf("error %q should report the runtime, not the missing adapter", err)
	}
	if strings.Contains(err.Error(), "claudeCodeAcpBinary") {
		t.Errorf("error %q points at the adapter key, but the runtime is the blocking problem", err)
	}
}

// A node on a stalled network mount must not wedge acp.open with no error.
func TestNodeVersionOutputWithin_Timeout(t *testing.T) {
	stub := filepath.Join(t.TempDir(), "node")
	// exec, so the process that hangs IS the child the deadline kills — a
	// wrapping shell would leave `sleep` behind unreaped.
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	out, err := nodeVersionOutputWithin(50*time.Millisecond, stub)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatalf("expected an error from a node that never answers, got %q", out)
	}
	if elapsed > 5*time.Second {
		t.Errorf("took %s: `node --version` must be bounded, it runs on the acp.open path", elapsed)
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
