package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Codex has no native ACP mode: sessions run through the external
// @agentclientprotocol/codex-acp adapter, a Node program that speaks ACP on
// stdio and drives `codex app-server` underneath. Every host-touching seam
// (PATH lookup, well-known path probing, `node --version`, os.Getenv) is
// injected in every case below, so no test needs codex, node or npx installed
// and none spawns a process (see the Go test hygiene note in CLAUDE.md).

// stubCodexHost replaces the descriptor's host seams. installed maps an
// executable name to the absolute path PATH would report for it; anything absent
// is "not on PATH". No well-known path exists unless a case overrides
// isExecutable. nodeVersion is what `node --version` prints for every candidate.
//
// getenv also answers CODEX_API_KEY/OPENAI_API_KEY: a node-agent service really
// may have those in its environment (that is where key auth belongs), and no
// test should be able to pass just because the fixture had no secret to leak.
func stubCodexHost(t *testing.T, d Descriptor, installed map[string]string, nodeVersion string) *codexDescriptor {
	t.Helper()
	c, ok := d.(*codexDescriptor)
	if !ok {
		t.Fatalf("expected *codexDescriptor, got %T", d)
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
		switch name {
		case "PATH":
			return testStubPath
		case "CODEX_API_KEY":
			return "sk-codex-super-secret"
		case "OPENAI_API_KEY":
			return "sk-openai-super-secret"
		}
		return ""
	}
	return c
}

// codexACP builds a descriptor over the standard fixture and returns it
// alongside the station key and workspace of project A.
func codexACP(t *testing.T, cfg CodexConfig) (Descriptor, string, string) {
	t.Helper()
	home, projA, _ := buildCodexFixture(t)
	cfg.Home = home
	d := NewCodexFrom(cfg)
	return d, codexKeyFor(projA), projA
}

func codexACPCommander(t *testing.T, d Descriptor) ACPCommander {
	t.Helper()
	c, ok := d.(ACPCommander)
	if !ok {
		t.Fatal("codex descriptor must implement ACPCommander")
	}
	return c
}

// envValue returns the value of name in env, and whether it was present.
func envValue(env []string, name string) (string, bool) {
	for _, e := range env {
		if strings.HasPrefix(e, name+"=") {
			return strings.TrimPrefix(e, name+"="), true
		}
	}
	return "", false
}

// --- adapter resolution ---

// The operator's override is the escape hatch: used verbatim, without a PATH
// lookup that might second-guess it.
func TestCodexACPCommand_ConfigAdapterOverrideWinsVerbatim(t *testing.T) {
	d, key, projA := codexACP(t, CodexConfig{AcpBinary: "/opt/custom/bin/codex-acp"})
	stubCodexHost(t, d, map[string]string{
		"codex-acp": "/usr/local/bin/codex-acp",
		"npx":       "/usr/bin/npx",
		"node":      "/usr/bin/node",
	}, "v22.14.0")

	argv, dir, _, err := codexACPCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := []string{"/opt/custom/bin/codex-acp"}; !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if dir != projA {
		t.Errorf("dir = %q, want the station's project path %q", dir, projA)
	}
}

// An installed adapter beats npx: it starts instantly and can't change under us
// between two sessions.
func TestCodexACPCommand_InstalledAdapterBeatsNpx(t *testing.T) {
	d, key, projA := codexACP(t, CodexConfig{})
	stubCodexHost(t, d, map[string]string{
		"codex-acp": "/usr/local/bin/codex-acp",
		"npx":       "/usr/bin/npx",
		"node":      "/usr/bin/node",
	}, "v22.14.0")

	argv, dir, _, err := codexACPCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := []string{"/usr/local/bin/codex-acp"}; !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want the PATH-resolved adapter %v", argv, want)
	}
	if dir != projA {
		t.Errorf("dir = %q, want the station's project path %q", dir, projA)
	}
}

// A pnpm/npm-global install is invisible to a systemd user service's PATH, so
// the well-known directories are probed in the documented order.
func TestCodexACPCommand_ProbesWellKnownPathsInOrder(t *testing.T) {
	d, key, _ := codexACP(t, CodexConfig{})
	c := stubCodexHost(t, d, nil, "v22.14.0")
	var probed []string
	c.isExecutable = func(path string) bool {
		if filepath.Base(path) == "codex-acp" {
			probed = append(probed, path)
		}
		return false
	}

	if _, _, _, err := codexACPCommander(t, d).ACPCommand(key); err == nil {
		t.Fatal("expected an error when nothing resolves")
	}

	want := []string{
		filepath.Join(testStubHome, ".local", "share", "pnpm", "codex-acp"),
		filepath.Join(testStubHome, ".local", "bin", "codex-acp"),
		"/usr/local/bin/codex-acp",
		"/usr/bin/codex-acp",
		"/opt/homebrew/bin/codex-acp",
	}
	if !reflect.DeepEqual(probed, want) {
		t.Errorf("probed %v, want %v", probed, want)
	}
}

// The npx fallback MUST pin the version. An unpinned `npx -y <pkg>` would let
// the whole fleet's adapter change silently between two sessions.
func TestCodexACPCommand_NpxFallbackIsPinned(t *testing.T) {
	d, key, projA := codexACP(t, CodexConfig{})
	stubCodexHost(t, d, map[string]string{
		"npx":  "/usr/bin/npx",
		"node": "/usr/bin/node",
	}, "v22.14.0")

	argv, dir, _, err := codexACPCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	want := []string{"/usr/bin/npx", "-y", "@agentclientprotocol/codex-acp@1.1.14"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if dir != projA {
		t.Errorf("dir = %q, want %q", dir, projA)
	}
}

func TestCodexACPCommand_NothingResolvable(t *testing.T) {
	d, key, _ := codexACP(t, CodexConfig{})
	stubCodexHost(t, d, nil, "v22.14.0")

	_, _, _, err := codexACPCommander(t, d).ACPCommand(key)
	if err == nil {
		t.Fatal("expected an error rather than argv that exec would fail on later")
	}
	msg := err.Error()
	if !strings.Contains(msg, "codexAcpBinary") {
		t.Errorf("error %q must name the codexAcpBinary config key so the operator knows the fix", msg)
	}
	// The message composes into "Couldn't start the agent process — <err>".
	if strings.HasPrefix(msg, "Codex") || strings.HasSuffix(msg, ".") {
		t.Errorf("error %q must stay a lowercase sentence fragment", msg)
	}
}

// An unknown station has no project path, so there is nothing to resolve for.
func TestCodexACPCommand_BadKeySkipsResolution(t *testing.T) {
	d, _, _ := codexACP(t, CodexConfig{})
	c := stubCodexHost(t, d, map[string]string{
		"codex-acp": "/usr/local/bin/codex-acp",
		"node":      "/usr/bin/node",
	}, "v22.14.0")
	c.lookPath = func(name string) (string, error) {
		t.Errorf("PATH lookup for %q must not run for an unknown station key", name)
		return "", fmt.Errorf("not found")
	}
	c.nodeVersion = func(string) (string, error) {
		t.Error("node --version must not run for an unknown station key")
		return "v22.14.0", nil
	}

	if _, _, _, err := codexACPCommander(t, d).ACPCommand("codex:deadbeef"); err == nil {
		t.Fatal("expected an error for an unknown station key")
	}
}

// --- environment ---

// codexResolutionCase is one of the three ways the adapter can be resolved. The
// env invariants below must hold on ALL of them: they are properties of the
// session, not of how the binary happened to be found.
type codexResolutionCase struct {
	name      string
	cfg       CodexConfig
	installed map[string]string
}

func codexResolutionCases() []codexResolutionCase {
	return []codexResolutionCase{
		// Every case has a node ON PATH but none configures nodeBinary — the
		// ordinary fleet host, and what makes the "no wasted probe" case below
		// bite in all three.
		{"config override", CodexConfig{AcpBinary: "/opt/custom/bin/codex-acp"}, map[string]string{"node": "/usr/bin/node"}},
		{"resolved adapter", CodexConfig{}, map[string]string{"codex-acp": "/usr/local/bin/codex-acp", "node": "/usr/bin/node"}},
		{"npx fallback", CodexConfig{}, map[string]string{"npx": "/usr/bin/npx", "node": "/usr/bin/node"}},
	}
}

// A fleet node is headless: the adapter must never offer (let alone attempt) the
// browser ChatGPT login, whichever way the adapter itself was resolved.
func TestCodexACPCommand_AlwaysDisablesBrowserAuth(t *testing.T) {
	for _, tc := range codexResolutionCases() {
		t.Run(tc.name, func(t *testing.T) {
			d, key, _ := codexACP(t, tc.cfg)
			stubCodexHost(t, d, tc.installed, "v22.14.0")

			_, _, env, err := codexACPCommander(t, d).ACPCommand(key)
			if err != nil {
				t.Fatalf("ACPCommand: %v", err)
			}
			if got, ok := envValue(env, "NO_BROWSER"); !ok || got != "1" {
				t.Errorf("env = %v, want NO_BROWSER=1 — a fleet node must never try to open a browser", env)
			}
		})
	}
}

// The agent's permission posture must be OURS and visible, never inherited from
// whatever the adapter defaults to. The console gates the Chat tab purely on the
// "acp" capability, so the moment a node updates, every detected Codex project
// gets a Chat tab — and the hub's ask/accept-edits/full-auto modes are only a
// safety net if the agent actually asks. "agent" is the approval-seeking mode.
func TestCodexACPCommand_SetsApprovalSeekingAgentMode(t *testing.T) {
	for _, tc := range codexResolutionCases() {
		t.Run(tc.name, func(t *testing.T) {
			d, key, _ := codexACP(t, tc.cfg)
			stubCodexHost(t, d, tc.installed, "v22.14.0")

			_, _, env, err := codexACPCommander(t, d).ACPCommand(key)
			if err != nil {
				t.Fatalf("ACPCommand: %v", err)
			}
			if got, ok := envValue(env, "INITIAL_AGENT_MODE"); !ok || got != "agent" {
				t.Errorf("env = %v, want INITIAL_AGENT_MODE=agent — the posture must be set explicitly, not inherited", env)
			}
		})
	}
}

// The other half of that decision, and the half a value assertion can't cover: a
// fleet node is NEVER opted into Codex's full-access mode. That is a property of
// the whole file, not of one code path — an unattended host is the worst place to
// hand an agent unprompted write-and-execute — so the source is what gets
// checked. (Deliberately: the prose in codex.go says "full access" with a space
// for exactly this reason, so the ban can be spelled here and nowhere else.)
func TestCodexACPCommand_NeverOptsIntoFullAccess(t *testing.T) {
	src, err := os.ReadFile("codex.go")
	if err != nil {
		t.Fatalf("reading codex.go: %v", err)
	}
	if strings.Contains(string(src), "full-access") {
		t.Error("codex.go mentions the full-access agent mode: a fleet node must never be opted into it")
	}
}

// CODEX_PATH is OPT-IN ONLY. This is the regression test for a real live
// failure: auto-discovery pointed the adapter at the node's own
// /opt/homebrew/bin/codex (v0.36.0), which has no `app-server` subcommand at
// all — codex-acp drives exactly that interface, so the old CLI fell into
// interactive mode and died on a TTY it does not have:
//
//	Codex process has exited with code 1: Error: Device not configured (os error 6)
//
// With no CODEX_PATH the adapter uses its own bundled Codex (v0.147.0) and the
// ACP handshake succeeds. So a discoverable codex must NEVER be volunteered: the
// CLAUDE_CODE_EXECUTABLE analogy does not transfer, because Claude Code's adapter
// tolerates the CLI it drives while codex-acp requires a specific interface from
// it. Guessing is strictly worse than the known-good default.
func TestCodexACPCommand_NeverAutoDiscoversCodexPath(t *testing.T) {
	t.Run("codex on PATH", func(t *testing.T) {
		d, key, _ := codexACP(t, CodexConfig{})
		stubCodexHost(t, d, map[string]string{
			"codex-acp": "/usr/local/bin/codex-acp",
			"codex":     "/opt/homebrew/bin/codex", // the v0.36.0 that broke the live node
			"node":      "/usr/bin/node",
		}, "v22.14.0")

		_, _, env, err := codexACPCommander(t, d).ACPCommand(key)
		if err != nil {
			t.Fatalf("ACPCommand: %v", err)
		}
		if got, ok := envValue(env, "CODEX_PATH"); ok {
			t.Errorf("env volunteered CODEX_PATH=%q from PATH discovery: an un-vetted codex may predate `app-server` and kill the session", got)
		}
	})

	t.Run("codex in a well-known dir", func(t *testing.T) {
		shim := filepath.Join(testStubHome, ".local", "bin", "codex")
		d, key, _ := codexACP(t, CodexConfig{})
		c := stubCodexHost(t, d, map[string]string{
			"codex-acp": "/usr/local/bin/codex-acp",
			"node":      "/usr/bin/node",
		}, "v22.14.0")
		c.isExecutable = func(path string) bool { return path == shim }

		_, _, env, err := codexACPCommander(t, d).ACPCommand(key)
		if err != nil {
			t.Fatalf("ACPCommand: %v", err)
		}
		if got, ok := envValue(env, "CODEX_PATH"); ok {
			t.Errorf("env volunteered CODEX_PATH=%q from the well-known-path probe", got)
		}
	})

	// Belt and braces: the probe must not even be ATTEMPTED, so re-adding
	// discovery can't sneak back in behind a resolver that happens to find
	// nothing on this particular host.
	t.Run("no codex lookup happens at all", func(t *testing.T) {
		d, key, _ := codexACP(t, CodexConfig{})
		c := stubCodexHost(t, d, map[string]string{
			"codex-acp": "/usr/local/bin/codex-acp",
			"node":      "/usr/bin/node",
		}, "v22.14.0")
		inner := c.lookPath
		c.lookPath = func(name string) (string, error) {
			if name == "codex" {
				t.Error("looked up `codex` on PATH: CODEX_PATH is opt-in via codexBinary only")
			}
			return inner(name)
		}
		c.isExecutable = func(path string) bool {
			if filepath.Base(path) == "codex" {
				t.Errorf("probed %q for a codex: CODEX_PATH is opt-in via codexBinary only", path)
			}
			return false
		}

		if _, _, _, err := codexACPCommander(t, d).ACPCommand(key); err != nil {
			t.Fatalf("ACPCommand: %v", err)
		}
	})
}

// The escape hatch: an operator whose codex is new enough to expose `app-server`
// names it, and takes responsibility for that. Used verbatim.
func TestCodexACPCommand_CodexBinaryOverride(t *testing.T) {
	d, key, _ := codexACP(t, CodexConfig{CodexBinary: "/opt/codex/bin/codex"})
	stubCodexHost(t, d, map[string]string{
		"codex-acp": "/usr/local/bin/codex-acp",
		"codex":     "/usr/local/bin/codex",
		"node":      "/usr/bin/node",
	}, "v22.14.0")

	_, _, env, err := codexACPCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if got, ok := envValue(env, "CODEX_PATH"); !ok || got != "/opt/codex/bin/codex" {
		t.Errorf("env = %v, want the configured codexBinary as CODEX_PATH", env)
	}
}

// The default configuration, and the one the live probe proved works: nothing
// configured, nothing volunteered, the adapter's own bundled Codex carries the
// session.
func TestCodexACPCommand_NoCodexLeavesCodexPathUnset(t *testing.T) {
	d, key, _ := codexACP(t, CodexConfig{})
	stubCodexHost(t, d, map[string]string{
		"codex-acp": "/usr/local/bin/codex-acp",
		"node":      "/usr/bin/node",
	}, "v22.14.0")

	_, _, env, err := codexACPCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if got, ok := envValue(env, "CODEX_PATH"); ok {
		t.Errorf("env sets CODEX_PATH=%q, but no codex was found on this node", got)
	}
}

// Key auth belongs in the node-agent SERVICE's environment, which the adapter
// inherits — never in node config, and never read into argv (world-readable via
// ps) or into the extra env the hub logs.
func TestCodexACPCommand_NeverCarriesAnApiKey(t *testing.T) {
	d, key, _ := codexACP(t, CodexConfig{})
	stubCodexHost(t, d, map[string]string{
		"codex-acp": "/usr/local/bin/codex-acp",
		"codex":     "/usr/local/bin/codex",
		"node":      "/usr/bin/node",
	}, "v22.14.0")

	argv, _, env, err := codexACPCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	for _, s := range append(append([]string{}, argv...), env...) {
		lower := strings.ToLower(s)
		for _, banned := range []string{"api_key", "apikey", "token", "secret", "sk-"} {
			if strings.Contains(lower, banned) {
				t.Errorf("command carries a credential-shaped value %q", s)
			}
		}
	}
}

// --- node runtime ---

// codex-acp declares NO `engines` field, so there is no documented minimum to
// enforce: refusing a session on a version the package never asked for would
// invent a requirement. The runtime is still SELECTED the same way, so a
// configured nodeBinary wins the spawn.
func TestCodexACPCommand_OldNodeIsNotRefused(t *testing.T) {
	for _, version := range []string{"v18.19.0", "v20.11.1"} {
		t.Run(version, func(t *testing.T) {
			d, key, _ := codexACP(t, CodexConfig{})
			stubCodexHost(t, d, map[string]string{
				"codex-acp": "/usr/local/bin/codex-acp",
				"node":      "/usr/bin/node",
			}, version)

			argv, _, _, err := codexACPCommander(t, d).ACPCommand(key)
			if err != nil {
				t.Fatalf("codex-acp states no engines requirement, so node %s must not be refused: %v", version, err)
			}
			if want := []string{"/usr/local/bin/codex-acp"}; !reflect.DeepEqual(argv, want) {
				t.Errorf("argv = %v, want %v", argv, want)
			}
		})
	}
}

// With no version to enforce, a runtime probe is only ever worth a fork when
// there is a CONFIGURED node to prefer — that is the single case whose outcome
// can change argv or PATH. Without nodeBinary the answer is structurally always
// "" (the selector returns a dir only when the winner IS the configured node),
// so probing would be pure cost: `node --version` on a host whose node sits on a
// stalled NFS/autofs mount burns the full 2s timeout on EVERY acp.open, before
// argv is even resolved.
func TestCodexACPCommand_NoNodeProbeWithoutConfiguredRuntime(t *testing.T) {
	for _, tc := range codexResolutionCases() {
		t.Run(tc.name, func(t *testing.T) {
			if tc.cfg.NodeBinary != "" {
				t.Fatal("this case is about the UNconfigured runtime")
			}
			d, key, _ := codexACP(t, tc.cfg)
			c := stubCodexHost(t, d, tc.installed, "v22.14.0")
			c.nodeVersion = func(nodePath string) (string, error) {
				t.Errorf("forked `%s --version` with no nodeBinary configured: the result cannot affect argv or env", nodePath)
				return "v22.14.0", nil
			}

			if _, _, _, err := codexACPCommander(t, d).ACPCommand(key); err != nil {
				t.Fatalf("ACPCommand: %v", err)
			}
		})
	}
}

// The other half of "select, don't gate", and the case that pins the zero
// minimum: claude-code steps over a configured node older than Node 22 because
// its adapter documents that floor. codex-acp documents none, so there is
// nothing to judge an "old" runtime against — the operator's explicit
// nodeBinary is the best signal available and keeps the spawn.
func TestCodexACPCommand_ConfiguredNodeWinsEvenWhenOlderThanPath(t *testing.T) {
	const (
		configuredDir = "/opt/node-18/bin"
		configured    = configuredDir + "/node"
	)
	d, key, _ := codexACP(t, CodexConfig{NodeBinary: configured})
	c := stubCodexHost(t, d, map[string]string{
		"codex-acp": "/usr/local/bin/codex-acp",
		"node":      "/usr/bin/node",
	}, "")
	c.nodeVersion = nodeVersions(map[string]string{
		configured:      "v18.19.0",
		"/usr/bin/node": "v22.14.0",
	})

	_, _, env, err := codexACPCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if got, ok := envValue(env, "PATH"); !ok || !strings.HasPrefix(got, configuredDir+string(os.PathListSeparator)) {
		t.Errorf("PATH = %q, want the configured runtime's dir %q first: codex-acp names no minimum, so the configured node is not stepped over", got, configuredDir)
	}
}

// The npx shipped with a hand-installed node lives beside it, not on PATH — and
// npx execs `node` through PATH, so a configured runtime must win both.
func TestCodexACPCommand_ConfiguredNodeWinsSpawn(t *testing.T) {
	const (
		configuredDir = "/opt/node-22/bin"
		configured    = configuredDir + "/node"
	)
	d, key, _ := codexACP(t, CodexConfig{NodeBinary: configured})
	c := stubCodexHost(t, d, map[string]string{
		"node": "/usr/bin/node",
		"npx":  "/usr/bin/npx", // the old node's npx
	}, "")
	c.nodeVersion = nodeVersions(map[string]string{
		configured:      "v22.14.0",
		"/usr/bin/node": "v18.19.0",
	})
	c.isExecutable = func(path string) bool { return path == configuredDir+"/npx" }

	argv, _, env, err := codexACPCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if want := configuredDir + "/npx"; argv[0] != want {
		t.Errorf("argv[0] = %q, want the configured runtime's npx %q", argv[0], want)
	}
	if got, _ := envValue(env, "PATH"); !strings.HasPrefix(got, configuredDir+string(os.PathListSeparator)) {
		t.Errorf("PATH = %q, want the configured runtime's dir %q first", got, configuredDir)
	}
	if got, _ := envValue(env, "PATH"); !strings.HasSuffix(got, testStubPath) {
		t.Errorf("PATH = %q must PREPEND to the inherited PATH %q, not replace it", got, testStubPath)
	}
}

// A mistyped nodeBinary must not put a nonexistent directory at the front of the
// session's PATH: it falls through to whatever the host really has.
func TestCodexACPCommand_UnusableNodeBinaryFallsBackToPath(t *testing.T) {
	d, key, _ := codexACP(t, CodexConfig{NodeBinary: "/opt/node-22/bni/node"})
	c := stubCodexHost(t, d, map[string]string{
		"codex-acp": "/usr/local/bin/codex-acp",
		"node":      "/usr/bin/node",
	}, "")
	c.nodeVersion = nodeVersions(map[string]string{"/usr/bin/node": "v22.14.0"})

	_, _, env, err := codexACPCommander(t, d).ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if got, ok := envValue(env, "PATH"); ok {
		t.Errorf("PATH = %q, but the configured runtime is unusable — PATH must be left inherited", got)
	}
}

// NewCodex (the plain constructor used by older call sites) must still produce a
// working, production-wired descriptor.
func TestNewCodexStillImplementsACPCommander(t *testing.T) {
	home, _, _ := buildCodexFixture(t)
	if _, ok := NewCodex(home).(ACPCommander); !ok {
		t.Fatal("NewCodex must return a descriptor implementing ACPCommander")
	}
}
