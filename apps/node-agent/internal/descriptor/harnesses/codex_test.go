package harnesses

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// buildCodexFixture writes a realistic ~/.codex/config.toml containing three
// [projects."<path>"] tables — one path with a space in it, one that does not
// exist on disk — plus unrelated top-level keys and unrelated tables that must
// be ignored. It returns the codex home and the two project dirs that exist.
func buildCodexFixture(t *testing.T) (home, projA, projB string) {
	t.Helper()
	root := t.TempDir()

	home = filepath.Join(root, ".codex")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("MkdirAll codex home: %v", err)
	}

	projA = filepath.Join(root, "Projects", "periscope")
	projB = filepath.Join(root, "Projects", "my project") // path with a space
	gone := filepath.Join(root, "Projects", "deleted-workspace")
	for _, p := range []string{projA, projB} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatalf("MkdirAll project: %v", err)
		}
	}

	cfg := fmt.Sprintf(`model = "gpt-5-codex"
model_reasoning_effort = "high"
personality = "concise"

[tui]
notifications = true

[projects.%q]
trust_level = "trusted"

[projects.%q]
trust_level = "trusted"

# a project directory that has since been deleted
[projects.%q]
trust_level = "trusted"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[shell_environment_policy]
inherit = "all"
`, projA, projB, gone)

	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(cfg), 0o644); err != nil {
		t.Fatalf("WriteFile config.toml: %v", err)
	}
	return home, projA, projB
}
