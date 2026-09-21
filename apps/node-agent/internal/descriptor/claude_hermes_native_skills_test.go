package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeNativeReadinessReportsSelectedInstalledPairButStaysClosed(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	root := t.TempDir()
	pkg := filepath.Join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp")
	entry := filepath.Join(pkg, "dist", "index.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkg, "package.json"), []byte(`{"name":"@agentclientprotocol/claude-agent-acp","version":"0.66.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	adapter := filepath.Join(root, "claude-agent-acp")
	if err := os.Symlink(entry, adapter); err != nil {
		t.Fatal(err)
	}
	engine := filepath.Join(root, "claude")
	if err := os.WriteFile(engine, []byte("#!/bin/sh\necho '2.1.278 (Claude Code)'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	c := stubClaudeCodeHost(t, d, map[string]string{"node": "/test/node", "claude-agent-acp": adapter, "claude": engine}, "v22.14.0")
	got, err := c.NativeSkillReadiness(context.Background(), key)
	if err != nil || got.Ready || got.AdapterPath != adapter || got.AdapterVersion != "0.66.0" || got.EngineVersion != "2.1.278 (Claude Code)" || !strings.Contains(got.Reason, "not verified") {
		t.Fatalf("readiness = %+v, err = %v", got, err)
	}
	if _, err := c.NativeSkillReadiness(context.Background(), "claude-code:unknown"); err == nil {
		t.Fatal("unknown station accepted")
	}
}

func TestClaudeNativeReadinessDoesNotResolveNpxFallback(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	c := stubClaudeCodeHost(t, d, map[string]string{"node": "/test/node", "npx": "/test/npx"}, "v22.14.0")
	got, err := c.NativeSkillReadiness(context.Background(), key)
	if err != nil || got.Ready || got.AdapterPath != "" || !strings.Contains(got.Reason, "npx") {
		t.Fatalf("readiness = %+v, err = %v", got, err)
	}
}

func TestHermesNativeReadinessRequiresDetectedStationAndTrustEvidence(t *testing.T) {
	binDir := t.TempDir()
	bin := filepath.Join(binDir, "hermes")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 'Hermes Agent v0.21.3'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	h := NewHermes(testdataHermesHome(t)).(*hermesDescriptor)
	got, err := h.NativeSkillReadiness(context.Background(), "hermes:coder-kai")
	if err != nil || got.Ready || got.AdapterPath != bin || got.EngineVersion != "Hermes Agent v0.21.3" || !strings.Contains(got.Reason, "trust") {
		t.Fatalf("readiness = %+v, err = %v", got, err)
	}
	if _, err := h.NativeSkillReadiness(context.Background(), "hermes:missing"); err == nil {
		t.Fatal("undetected profile accepted")
	}
}
