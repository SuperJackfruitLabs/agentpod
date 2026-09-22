package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Driven only by an explicit disposable-workspace probe. Ordinary CI never
// starts a harness. Set SJL_CLAUDE_ACP to an installed claude-agent-acp and
// SJL_CLAUDE_PROBE_NODE to a Node runtime to exercise the real adapter.
//
// This is the one test that proves the shipped probe works rather than the
// seam around it: it publishes a skill at .claude/skills/<name>/SKILL.md,
// starts a fresh isolated session, and checks both directions.
func TestClaudeACPDiscoverSkillsAgainstTheInstalledAdapter(t *testing.T) {
	adapter, node := os.Getenv("SJL_CLAUDE_ACP"), os.Getenv("SJL_CLAUDE_PROBE_NODE")
	if adapter == "" || node == "" {
		t.Skip("set SJL_CLAUDE_ACP and SJL_CLAUDE_PROBE_NODE to run the installed-adapter probe")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	bare := t.TempDir()
	without, err := claudeACPDiscoverSkills(ctx, adapter, bare, node)
	if err != nil {
		t.Fatalf("negative control could not start a session: %v", err)
	}
	if len(without) == 0 {
		t.Fatal("negative control advertised nothing, so the probe proves nothing in either direction")
	}
	for _, name := range without {
		if name == "sjl-probe-control" {
			t.Fatal("a workspace with no published skill advertised one")
		}
	}

	workspace := t.TempDir()
	skill := filepath.Join(workspace, ".claude", "skills", "sjl-probe-control")
	if err := os.MkdirAll(skill, 0o700); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: sjl-probe-control\ndescription: Synthetic control for the native discovery probe.\n---\n\nThis file exists to be discovered. It instructs nothing.\n"
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	with, err := claudeACPDiscoverSkills(ctx, adapter, workspace, node)
	if err != nil {
		t.Fatalf("probe could not start a session: %v", err)
	}
	found := false
	for _, name := range with {
		if name == "sjl-probe-control" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("a fresh session did not advertise the published skill; advertised %v", with)
	}
}
