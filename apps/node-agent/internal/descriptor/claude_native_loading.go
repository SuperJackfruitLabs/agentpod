package descriptor

import (
	"context"
	"fmt"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// NativeSkillLoading answers whether a new Claude session advertises the names
// a verified generation published. The probe is read-only: it starts the
// adapter under a disposable HOME, sends initialize and session/new, and never
// prompts or supplies client tools. A session already open on this workspace
// is unaffected and unobserved, so this reports what a fresh session sees and
// makes no claim about refreshing one that is already running.
func (c *claudeCodeDescriptor) NativeSkillLoading(ctx context.Context, key string, expected []string) (skills.Observation, error) {
	if len(expected) == 0 {
		return skills.Observation{Reason: "No native skill names were supplied to verify"}, nil
	}
	readiness, err := c.NativeSkillReadiness(ctx, key)
	if err != nil {
		return skills.Observation{}, err
	}
	if !readiness.Ready {
		return skills.Observation{Reason: readiness.Reason}, nil
	}
	workspace, err := c.projectPathForKey(key)
	if err != nil {
		return skills.Observation{}, err
	}
	nodePath, err := c.nativeSkillDiscoveryNode()
	if err != nil {
		return skills.Observation{Reason: err.Error()}, nil
	}
	advertised, err := c.nativeSkillDiscovery(ctx, readiness.AdapterPath, workspace, nodePath)
	if err != nil {
		return skills.Observation{}, fmt.Errorf("fresh isolated Claude session could not establish discovery: %w", err)
	}
	seen := make(map[string]bool, len(advertised))
	for _, name := range advertised {
		seen[name] = true
	}
	for _, name := range expected {
		if !seen[name] {
			return observedNativeSkillLoading(false, "A fresh isolated ACP session did not advertise "+name), nil
		}
	}
	return observedNativeSkillLoading(true, "A fresh isolated ACP session advertised every expected native skill name"), nil
}

// nativeSkillDiscoveryNode resolves a Node runtime for the isolated probe. The
// node service often carries a smaller PATH than an operator's shell, while
// the adapter's shim invokes `/usr/bin/env node`, so the selected runtime's
// directory is prepended to the disposable process's PATH rather than assuming
// the service PATH already contains one.
func (c *claudeCodeDescriptor) nativeSkillDiscoveryNode() (string, error) {
	candidates := make([]string, 0, 2)
	if c.nodeBinary != "" {
		candidates = append(candidates, c.nodeBinary)
	}
	if resolved, ok := c.locator().locate("node", ""); ok {
		candidates = append(candidates, resolved)
	}
	for _, candidate := range candidates {
		out, err := c.nodeVersion(candidate)
		if err != nil {
			continue
		}
		if _, ok := parseNodeMajor(out); ok {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("Claude loading evidence was not collected: a usable Node runtime could not be resolved for claude-agent-acp")
}
