package opencode

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func publishSkill(t *testing.T, workspace, relative, name string) {
	t.Helper()
	dir := filepath.Join(workspace, relative, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: " + name + "\ndescription: Synthetic control for the native discovery probe.\n---\n\nThis file exists to be discovered. It instructs nothing.\n"
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// Set SJL_OPENCODE to the installed CLI to exercise the real adapter.
func TestOpenCodeACPDiscoverSkillsAgainstTheInstalledAdapter(t *testing.T) {
	binary := os.Getenv("SJL_OPENCODE")
	if binary == "" {
		t.Skip("set SJL_OPENCODE to run the installed-adapter probe")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	bare := t.TempDir()
	without, err := openCodeACPDiscoverSkills(ctx, binary, bare)
	if err != nil {
		t.Fatalf("negative control could not start a session: %v", err)
	}
	for _, name := range without {
		if name == "sjl-probe-control" {
			t.Fatal("a workspace with no published skill advertised one")
		}
	}

	workspace := t.TempDir()
	publishSkill(t, workspace, ".opencode/skills", "sjl-probe-control")
	with, err := openCodeACPDiscoverSkills(ctx, binary, workspace)
	if err != nil {
		t.Fatalf("probe could not start a session: %v", err)
	}
	for _, name := range with {
		if name == "sjl-probe-control" {
			return
		}
	}
	t.Fatalf("a fresh session did not advertise the published skill; advertised %v", with)
}
