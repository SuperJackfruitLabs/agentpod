package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The resolver is exercised entirely through injected lookPath/isExecutable
// funcs: no case may depend on the host's PATH or on openclaw being installed.

func TestResolveOpenClawBinary_OverrideWinsVerbatim(t *testing.T) {
	lookPathCalled := false
	lookPath := func(string) (string, error) {
		lookPathCalled = true
		return "/usr/bin/openclaw", nil
	}
	got, err := resolveOpenClawBinary("/opt/custom/bin/openclaw", "/home/openclaw", lookPath, func(string) bool { return true })
	if err != nil {
		t.Fatalf("resolveOpenClawBinary: %v", err)
	}
	if got != "/opt/custom/bin/openclaw" {
		t.Errorf("binary = %q, want the configured override used verbatim", got)
	}
	if lookPathCalled {
		t.Error("an explicit override must not be second-guessed by a PATH lookup")
	}
}

func TestResolveOpenClawBinary_UsesPathHit(t *testing.T) {
	lookPath := func(name string) (string, error) {
		if name != "openclaw" {
			t.Errorf("lookPath(%q), want lookPath(\"openclaw\")", name)
		}
		return "/usr/bin/openclaw", nil
	}
	probed := false
	got, err := resolveOpenClawBinary("", "/home/openclaw", lookPath, func(string) bool {
		probed = true
		return true
	})
	if err != nil {
		t.Fatalf("resolveOpenClawBinary: %v", err)
	}
	if got != "/usr/bin/openclaw" {
		t.Errorf("binary = %q, want the PATH hit /usr/bin/openclaw", got)
	}
	if probed {
		t.Error("well-known paths must only be probed when PATH misses")
	}
}

// The bug this fixes: on a node-agent running as a systemd *user* service the
// inherited PATH excludes ~/.local/share/pnpm, so a pnpm global install of
// openclaw is invisible to LookPath even though the shim works in a shell.
func TestResolveOpenClawBinary_FallsBackToPnpmShim(t *testing.T) {
	shim := filepath.Join("/home/openclaw", ".local", "share", "pnpm", "openclaw")
	lookPath := func(string) (string, error) { return "", fmt.Errorf("not found in $PATH") }
	isExecutable := func(path string) bool { return path == shim || path == "/usr/bin/openclaw" }

	got, err := resolveOpenClawBinary("", "/home/openclaw", lookPath, isExecutable)
	if err != nil {
		t.Fatalf("resolveOpenClawBinary: %v", err)
	}
	if got != shim {
		t.Errorf("binary = %q, want the pnpm shim %q (probed before /usr/bin)", got, shim)
	}
}

func TestResolveOpenClawBinary_ProbesWellKnownPathsInOrder(t *testing.T) {
	home := "/home/openclaw"
	want := []string{
		filepath.Join(home, ".local", "share", "pnpm", "openclaw"),
		filepath.Join(home, ".local", "bin", "openclaw"),
		"/usr/local/bin/openclaw",
		"/usr/bin/openclaw",
		"/opt/homebrew/bin/openclaw",
	}
	for _, only := range want {
		lookPath := func(string) (string, error) { return "", fmt.Errorf("not found in $PATH") }
		got, err := resolveOpenClawBinary("", home, lookPath, func(path string) bool { return path == only })
		if err != nil {
			t.Fatalf("resolveOpenClawBinary with only %q installed: %v", only, err)
		}
		if got != only {
			t.Errorf("binary = %q, want %q", got, only)
		}
	}

	var probed []string
	lookPath := func(string) (string, error) { return "", fmt.Errorf("not found in $PATH") }
	if _, err := resolveOpenClawBinary("", home, lookPath, func(path string) bool {
		probed = append(probed, path)
		return false
	}); err == nil {
		t.Fatal("expected an error when nothing is installed")
	}
	if len(probed) != len(want) {
		t.Fatalf("probed %v, want the %d well-known paths %v", probed, len(want), want)
	}
	for i := range want {
		if probed[i] != want[i] {
			t.Errorf("probe %d = %q, want %q", i, probed[i], want[i])
		}
	}
}

// No home directory (os.UserHomeDir failed) must not produce relative garbage
// candidates like ".local/share/pnpm/openclaw".
func TestResolveOpenClawBinary_SkipsHomeCandidatesWithoutHome(t *testing.T) {
	lookPath := func(string) (string, error) { return "", fmt.Errorf("not found in $PATH") }
	_, err := resolveOpenClawBinary("", "", lookPath, func(path string) bool {
		if !filepath.IsAbs(path) {
			t.Errorf("probed relative candidate %q", path)
		}
		return false
	})
	if err == nil {
		t.Fatal("expected an error when nothing is installed")
	}
}

func TestResolveOpenClawBinary_ActionableErrorNamesConfigKey(t *testing.T) {
	lookPath := func(string) (string, error) { return "", fmt.Errorf("not found in $PATH") }
	_, err := resolveOpenClawBinary("", "/home/openclaw", lookPath, func(string) bool { return false })
	if err == nil {
		t.Fatal("expected an error when openclaw resolves nowhere")
	}
	msg := err.Error()
	if !strings.Contains(msg, "openclawBinary") {
		t.Errorf("error %q must name the openclawBinary config key so the operator knows the fix", msg)
	}
	// The message composes into "Couldn't start the agent process — <err>".
	if strings.HasPrefix(msg, "Openclaw") || strings.HasSuffix(msg, ".") {
		t.Errorf("error %q must stay a lowercase sentence fragment", msg)
	}
}

func TestIsExecutableFile(t *testing.T) {
	dir := t.TempDir()

	plain := filepath.Join(dir, "openclaw-plain")
	if err := os.WriteFile(plain, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if isExecutableFile(plain) {
		t.Error("a non-executable file must not resolve as the binary")
	}
	if err := os.Chmod(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	if !isExecutableFile(plain) {
		t.Error("an executable file must resolve as the binary")
	}
	if isExecutableFile(filepath.Join(dir, "missing")) {
		t.Error("a missing path must not resolve as the binary")
	}
	if isExecutableFile(dir) {
		t.Error("a directory must not resolve as the binary")
	}

	// pnpm installs a symlink shim; resolution must follow it.
	link := filepath.Join(dir, "openclaw-shim")
	if err := os.Symlink(plain, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if !isExecutableFile(link) {
		t.Error("a symlink to an executable (the pnpm shim shape) must resolve")
	}
}

// --- ACPCommand integration ---

func TestOpenClawACPCommand_UsesResolvedBinary(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{Home: home})
	o := stubOpenClawHost(t, d, true)
	shim := "/home/openclaw/.local/share/pnpm/openclaw"
	o.resolveBinary = func() (string, error) { return shim, nil }

	argv, _, _, err := d.(ACPCommander).ACPCommand("openclaw")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if argv[0] != shim {
		t.Errorf("argv[0] = %q, want the resolved binary %q — a bare name relies on PATH", argv[0], shim)
	}
}

// The config override goes through the production resolver wiring (no seam
// injection), which is the whole point of the escape hatch.
func TestOpenClawACPCommand_ConfigBinaryOverride(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{
		Home:   home,
		Binary: "/opt/custom/bin/openclaw",
		// A gateway URL keeps the local gateway probe out of this test.
		GatewayURL: "wss://gateway.invalid:18789",
	})

	argv, _, _, err := d.(ACPCommander).ACPCommand("openclaw")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if argv[0] != "/opt/custom/bin/openclaw" {
		t.Errorf("argv[0] = %q, want the configured openclawBinary", argv[0])
	}
}

func TestOpenClawACPCommand_UnresolvableBinary(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{Home: home})
	o := stubOpenClawHost(t, d, true)
	o.resolveBinary = func() (string, error) {
		return "", fmt.Errorf("openclaw: couldn't find the openclaw binary on this node — set openclawBinary in the node config")
	}

	_, _, _, err := d.(ACPCommander).ACPCommand("openclaw")
	if err == nil {
		t.Fatal("expected an error rather than argv that exec would fail on later")
	}
	if !strings.Contains(err.Error(), "openclawBinary") {
		t.Errorf("error %q must name the openclawBinary config key", err)
	}
}

// A node with neither the binary nor a gateway reports the missing binary: it is
// the more fundamental failure (a running gateway is useless without the CLI)
// and its fix is a config key, not "start the gateway".
func TestOpenClawACPCommand_NoBinaryNoGatewayReportsBinary(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{Home: home})
	o := stubOpenClawHost(t, d, false)
	o.resolveBinary = func() (string, error) {
		return "", fmt.Errorf("openclaw: couldn't find the openclaw binary on this node — set openclawBinary in the node config")
	}

	_, _, _, err := d.(ACPCommander).ACPCommand("openclaw")
	if err == nil {
		t.Fatal("expected an error when neither the binary nor the gateway is present")
	}
	if !strings.Contains(err.Error(), "openclawBinary") {
		t.Errorf("error %q should report the missing binary first", err)
	}
	if strings.Contains(err.Error(), "gateway isn't running") {
		t.Errorf("error %q reports the gateway, but the binary is the blocking problem", err)
	}
}

// An unrecognized key is still rejected before any host probing.
func TestOpenClawACPCommand_BadKeySkipsBinaryResolution(t *testing.T) {
	d := NewOpenClawFrom(OpenClawConfig{Home: testdataOpenClawHome(t)})
	o := stubOpenClawHost(t, d, true)
	o.resolveBinary = func() (string, error) {
		t.Error("binary resolution must not run for an unrecognized station key")
		return "openclaw", nil
	}

	if _, _, _, err := d.(ACPCommander).ACPCommand("hermes:main"); err == nil {
		t.Fatal("expected error for unrecognized key")
	}
}
