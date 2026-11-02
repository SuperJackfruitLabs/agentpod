package opencode

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
)

// Run with AGENTPOD_OPENCODE_ACP_BINARY pointing at a reviewed OpenCode 1.18.15
// executable. This optional integration check uses a synthetic skill and a
// disposable workspace; it starts an ACP session but sends no model prompt.
func TestOpenCodeInstalledACPSkillDiscovery(t *testing.T) {
	binary := os.Getenv("AGENTPOD_OPENCODE_ACP_BINARY")
	if binary == "" {
		t.Skip("set AGENTPOD_OPENCODE_ACP_BINARY to run the installed-runtime probe")
	}
	if version := hostproc.NativeExecutableVersion(t.Context(), binary); version != "1.18.15" {
		t.Fatalf("expected reviewed OpenCode 1.18.15, got %q", version)
	}
	workspace := t.TempDir()
	// Match the exact grouped projection produced by native placement, not a
	// hand-written skill directly under the root.
	skillDir := filepath.Join(workspace, ".opencode", "skills", "sjl-fixture", "skills", "sjl-fixture")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: sjl-fixture\ndescription: Synthetic discovery probe.\n---\nSynthetic test.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	names, err := openCodeACPDiscoverSkills(t.Context(), binary, workspace)
	if err != nil || !slices.Contains(names, "sjl-fixture") {
		t.Fatalf("fresh ACP discovery names=%q err=%v", names, err)
	}
	sibling := t.TempDir()
	names, err = openCodeACPDiscoverSkills(t.Context(), binary, sibling)
	if err != nil || slices.Contains(names, "sjl-fixture") {
		t.Fatalf("sibling ACP discovery names=%q err=%v", names, err)
	}
}
