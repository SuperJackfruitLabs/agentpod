package descriptor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// claudeACPDiscoverSkills starts the selected adapter with a new, disposable
// HOME so no configured account, project trust or prior session influences
// what a fresh session advertises. It sends only ACP initialize and
// session/new; it never creates a prompt or gives the adapter client tools.
//
// Unlike Codex, Claude advertises skills under their plain command name
// alongside its built-in commands, so every advertised name is returned and
// the caller matches the names its own verified generation published.
func claudeACPDiscoverSkills(ctx context.Context, adapter, workspace, nodePath string) ([]string, error) {
	if adapter == "" || !filepath.IsAbs(adapter) || !filepath.IsAbs(workspace) || !filepath.IsAbs(nodePath) {
		return nil, fmt.Errorf("invalid Claude discovery scope")
	}
	home, err := os.MkdirTemp("", "agentpod-claude-skill-discovery-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(home)
	return discoverACPSkillCommands(ctx, []string{adapter}, workspace, []string{
		"PATH=" + pathWithDirFirst(filepath.Dir(nodePath), os.Getenv("PATH")),
		"HOME=" + home, "CLAUDE_CONFIG_DIR=" + filepath.Join(home, ".claude"),
		"NO_BROWSER=1", "LANG=C",
	}, func(name string) (string, bool) {
		return name, name != ""
	})
}
