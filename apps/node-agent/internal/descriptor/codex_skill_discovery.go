package descriptor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// codexACPDiscoverSkills starts the selected adapter with a new, disposable
// CODEX_HOME and an unreachable local provider. It sends only ACP initialize
// and session/new; it never creates a prompt or gives the adapter client tools.
func codexACPDiscoverSkills(ctx context.Context, adapter, workspace string) ([]string, error) {
	if adapter == "" || !filepath.IsAbs(adapter) || !filepath.IsAbs(workspace) {
		return nil, fmt.Errorf("invalid Codex discovery scope")
	}
	home, err := os.MkdirTemp("", "agentpod-codex-skill-discovery-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(home)
	config := "model_provider = \"synthetic\"\nmodel = \"gpt-5.4\"\n[model_providers.synthetic]\nname = \"AgentPod offline skill discovery\"\nbase_url = \"http://127.0.0.1:9/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n"
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0600); err != nil {
		return nil, err
	}
	return discoverACPSkillCommands(ctx, []string{adapter}, workspace, []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + home, "CODEX_HOME=" + home, "NO_BROWSER=1", "LANG=C",
	}, func(name string) (string, bool) {
		return strings.TrimPrefix(name, "$"), strings.HasPrefix(name, "$")
	})
}
