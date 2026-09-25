package descriptor

import (
	"context"
	"fmt"
)

// PluginManagementHarness is the one harness whose plugin apn can install:
// Hermes, with the agentpod-live plugin it embeds (#553).
const PluginManagementHarness = "hermes"

// EnablePluginManagement is called at startup only when the node's operator
// configuration lets the Console install and remove plugins. Detection then
// advertises plugins.manage on Hermes stations.
func (r *Registry) EnablePluginManagement() { r.pluginManagement = true }

// PluginProfileDir resolves a currently detected Hermes station to its profile
// directory. No caller-supplied path reaches the plugin installer.
func (r *Registry) PluginProfileDir(ctx context.Context, key string) (string, error) {
	if !r.pluginManagement {
		return "", fmt.Errorf("plugins: management is disabled in this node's operator configuration")
	}
	d, err := r.For(key)
	if err != nil {
		return "", err
	}
	if d.Harness() != PluginManagementHarness {
		return "", fmt.Errorf("plugins: management is unavailable for this harness")
	}
	return localManagedSkillWorkspace(ctx, d, key)
}
