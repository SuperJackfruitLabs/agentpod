package descriptor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// readyClaudeHost builds a descriptor whose adapter and engine are the probed
// pair, so loading tests exercise the probe rather than the readiness gate.
func readyClaudeHost(t *testing.T, discovery func(ctx context.Context, adapter, workspace, nodePath string) ([]string, error)) (*claudeCodeDescriptor, string) {
	t.Helper()
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
	node := filepath.Join(root, "node")
	if err := os.WriteFile(node, []byte("#!/bin/sh\necho v22.14.0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	c := stubClaudeCodeHost(t, d, map[string]string{"node": node, "claude-agent-acp": adapter, "claude": engine}, "v22.14.0")
	c.nativeSkillDiscovery = discovery
	return c, key
}

// Claude advertises a published skill under its plain command name beside its
// own built-in commands, so a session listing both is a positive observation.
func TestClaudeNativeLoadingSeesAPublishedSkillAmongBuiltins(t *testing.T) {
	c, key := readyClaudeHost(t, func(context.Context, string, string, string) ([]string, error) {
		return []string{"compact", "config", "sjl-fixture", "review"}, nil
	})
	got, err := c.NativeSkillLoading(context.Background(), key, []string{"sjl-fixture"})
	if err != nil || got.Value == nil || !*got.Value || got.ObservedAt == nil {
		t.Fatalf("loading = %+v, err = %v", got, err)
	}
}

// A session that does not advertise the published name is a negative
// observation, which is what a removal needs to prove itself.
func TestClaudeNativeLoadingReportsAnAbsentNameAsNotLoaded(t *testing.T) {
	c, key := readyClaudeHost(t, func(context.Context, string, string, string) ([]string, error) {
		return []string{"compact", "config", "review"}, nil
	})
	got, err := c.NativeSkillLoading(context.Background(), key, []string{"sjl-fixture"})
	if err != nil || got.Value == nil || *got.Value {
		t.Fatalf("loading = %+v, err = %v", got, err)
	}
	if !strings.Contains(got.Reason, "sjl-fixture") {
		t.Fatalf("a negative observation must name what was not advertised: %q", got.Reason)
	}
}

// A probe that could not run is unknown. It must never read as not-loaded:
// that would turn a broken probe into evidence that a skill is absent.
func TestClaudeNativeLoadingKeepsAFailedProbeUnknown(t *testing.T) {
	c, key := readyClaudeHost(t, func(context.Context, string, string, string) ([]string, error) {
		return nil, errors.New("ACP output closed before discovery completed")
	})
	_, err := c.NativeSkillLoading(context.Background(), key, []string{"sjl-fixture"})
	if err == nil {
		t.Fatal("a failed probe was reported as an observation")
	}
	if !strings.Contains(err.Error(), "could not establish discovery") {
		t.Fatalf("failure does not name the condition: %v", err)
	}
}

// Loading is gated on readiness, so an unprobed runtime yields unknown with
// the readiness reason rather than starting a session anyway.
func TestClaudeNativeLoadingDefersToAClosedReadinessGate(t *testing.T) {
	d, key, _ := claudeCodeACP(t, ClaudeCodeConfig{})
	c := stubClaudeCodeHost(t, d, map[string]string{"node": "/test/node", "npx": "/test/npx"}, "v22.14.0")
	c.nativeSkillDiscovery = func(context.Context, string, string, string) ([]string, error) {
		t.Fatal("a closed gate must not start a session")
		return nil, nil
	}
	got, err := c.NativeSkillLoading(context.Background(), key, []string{"sjl-fixture"})
	if err != nil || got.Value != nil || got.Reason == "" {
		t.Fatalf("loading = %+v, err = %v", got, err)
	}
}
