package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// openclawBinary must reach the descriptor: on a node where openclaw is installed
// outside the service's PATH (e.g. a pnpm global install under
// ~/.local/share/pnpm, invisible to a systemd *user* service) it is the
// operator's escape hatch. A gateway URL is configured so resolving the ACP
// command skips the local gateway probe.
func TestBuildRegistry_ThreadsOpenClawBinary(t *testing.T) {
	reg := buildRegistry(config.Config{
		OpenClawBinary:     "/opt/custom/bin/openclaw",
		OpenClawGatewayURL: "wss://gateway.invalid:18789",
	})

	d, err := reg.For("openclaw")
	if err != nil {
		t.Fatalf("registry has no openclaw descriptor: %v", err)
	}
	c, ok := d.(descriptor.ACPCommander)
	if !ok {
		t.Fatalf("openclaw descriptor must implement ACPCommander, got %T", d)
	}

	argv, _, _, err := c.ACPCommand("openclaw")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if argv[0] != "/opt/custom/bin/openclaw" {
		t.Errorf("argv[0] = %q, want the configured openclawBinary", argv[0])
	}
}

// The claude-code ACP keys are the same kind of escape hatch: claude-agent-acp
// is a Node program that a fleet host may have anywhere. This goes through the
// production seams (real LookPath, real `node --version`, real os.Getenv), so it
// is kept off the host's own installs: a HOME fixture supplies the station, and
// nodeBinary points at a stub that reports v22 — which is also what proves the
// key is threaded, since only a configured runtime is prepended to PATH.
func TestBuildRegistry_ThreadsClaudeCodeACPKeys(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	proj := filepath.Join(home, "work", "repo")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	nodeDir := filepath.Join(home, "runtime", "bin")
	if err := os.MkdirAll(nodeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	nodeStub := filepath.Join(nodeDir, "node")
	if err := os.WriteFile(nodeStub, []byte("#!/bin/sh\necho v22.14.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	doc, err := json.Marshal(map[string]any{"projects": map[string]any{proj: map[string]any{}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), doc, 0o644); err != nil {
		t.Fatal(err)
	}

	reg := buildRegistry(config.Config{
		ClaudeCodeAcpBinary: "/opt/custom/bin/claude-agent-acp",
		ClaudeCodeBinary:    "/opt/custom/bin/claude",
		NodeBinary:          nodeStub,
	})

	var key string
	for _, s := range reg.DetectAll() {
		if s.Harness == "claude-code" {
			key = s.Key
		}
	}
	if key == "" {
		t.Fatal("no claude-code station detected from the HOME fixture")
	}

	d, err := reg.For(key)
	if err != nil {
		t.Fatalf("registry has no claude-code descriptor: %v", err)
	}
	c, ok := d.(descriptor.ACPCommander)
	if !ok {
		t.Fatalf("claude-code descriptor must implement ACPCommander, got %T", d)
	}

	argv, dir, env, err := c.ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if argv[0] != "/opt/custom/bin/claude-agent-acp" {
		t.Errorf("argv[0] = %q, want the configured claudeCodeAcpBinary", argv[0])
	}
	if dir != proj {
		t.Errorf("dir = %q, want the station's project path %q", dir, proj)
	}
	if want := "CLAUDE_CODE_EXECUTABLE=/opt/custom/bin/claude"; !strings.Contains(strings.Join(env, " "), want) {
		t.Errorf("env = %v, want the configured claudeCodeBinary as %q", env, want)
	}
	var pathEntry string
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") {
			pathEntry = strings.TrimPrefix(e, "PATH=")
		}
	}
	if !strings.HasPrefix(pathEntry, nodeDir+string(os.PathListSeparator)) {
		t.Errorf("PATH = %q, want the configured nodeBinary's dir %q first", pathEntry, nodeDir)
	}
}

// The codex ACP keys are the same escape hatch for the codex-acp adapter. This
// goes through the production seams (real LookPath, real os.Getenv), so a HOME
// fixture supplies the ~/.codex/config.toml the station comes from and the
// configured adapter path is what proves the key is threaded.
func TestBuildRegistry_ThreadsCodexACPKeys(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	proj := filepath.Join(home, "work", "codex-repo")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	codexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatal(err)
	}
	cfgToml := "model = \"gpt-5-codex\"\n\n[projects.\"" + proj + "\"]\ntrust_level = \"trusted\"\n"
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(cfgToml), 0o644); err != nil {
		t.Fatal(err)
	}

	reg := buildRegistry(config.Config{
		CodexAcpBinary: "/opt/custom/bin/codex-acp",
		CodexBinary:    "/opt/custom/bin/codex",
	})

	var key string
	for _, s := range reg.DetectAll() {
		if s.Harness == "codex" {
			key = s.Key
		}
	}
	if key == "" {
		t.Fatal("no codex station detected from the HOME fixture")
	}

	d, err := reg.For(key)
	if err != nil {
		t.Fatalf("registry has no codex descriptor: %v", err)
	}
	c, ok := d.(descriptor.ACPCommander)
	if !ok {
		t.Fatalf("codex descriptor must implement ACPCommander, got %T", d)
	}

	argv, dir, env, err := c.ACPCommand(key)
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if argv[0] != "/opt/custom/bin/codex-acp" {
		t.Errorf("argv[0] = %q, want the configured codexAcpBinary", argv[0])
	}
	if dir != proj {
		t.Errorf("dir = %q, want the station's project path %q", dir, proj)
	}
	joined := strings.Join(env, " ")
	for _, want := range []string{"NO_BROWSER=1", "CODEX_PATH=/opt/custom/bin/codex"} {
		if !strings.Contains(joined, want) {
			t.Errorf("env = %v, want %q", env, want)
		}
	}
}
