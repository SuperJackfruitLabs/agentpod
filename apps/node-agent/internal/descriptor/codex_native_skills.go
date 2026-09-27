package descriptor

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// NativeSkillReadiness reports only the adapter/engine pair an ACP session
// would use. A configured CODEX_PATH is intentionally blocked: the user chose
// an engine outside the adapter bundle and AgentPod has no discovery evidence
// for that arbitrary binary.
func (c *codexDescriptor) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	workspace, err := c.projectPathForKey(key)
	if err != nil {
		return NativeSkillReadiness{}, err
	}
	if err := ctx.Err(); err != nil {
		return NativeSkillReadiness{}, err
	}
	if c.codexBinary != "" {
		return NativeSkillReadiness{Harness: "codex", Reason: "Configured CODEX_PATH is not covered by native discovery evidence"}, nil
	}
	adapter, ok := c.locator().locate(codexACPBinaryName, c.acpBinary)
	if !ok {
		return NativeSkillReadiness{Harness: "codex", Reason: "codex-acp is unresolved; npx fallback has no installed engine identity"}, nil
	}
	resolved, err := filepath.EvalSymlinks(adapter)
	if err != nil {
		return NativeSkillReadiness{Harness: "codex", Reason: "codex-acp path cannot be resolved", AdapterPath: adapter}, nil
	}
	root, adapterVersion := codexAdapterPackage(resolved)
	if adapterVersion == "" {
		return NativeSkillReadiness{Harness: "codex", Reason: "codex-acp package metadata is unavailable", AdapterPath: adapter}, nil
	}
	engineVersion := codexBundledEngineVersion(root)
	if engineVersion == "" {
		return NativeSkillReadiness{Harness: "codex", Reason: "codex-acp bundled engine metadata is unavailable", AdapterPath: adapter, AdapterVersion: adapterVersion}, nil
	}
	ready := (adapterVersion == "1.1.14" && engineVersion == "0.147.0") || (adapterVersion == "1.12.0" && engineVersion == "0.154.0")
	reason := "Adapter and bundled engine match isolated native discovery evidence; external-process quiescence is still required"
	if !ready {
		reason = "Adapter and bundled engine pair has no recorded native discovery evidence"
	}
	if ready {
		if running, note := c.processRunning(workspace); note != "" {
			return NativeSkillReadiness{Harness: "codex", Reason: "Direct Codex process inspection failed: " + note, AdapterPath: adapter, AdapterVersion: adapterVersion, EngineVersion: engineVersion}, nil
		} else if running {
			return NativeSkillReadiness{Harness: "codex", Reason: "A direct Codex process is active in this workspace", AdapterPath: adapter, AdapterVersion: adapterVersion, EngineVersion: engineVersion}, nil
		}
		if running, note := c.adapterRunning(adapter, workspace); note != "" {
			return NativeSkillReadiness{Harness: "codex", Reason: "codex-acp process inspection failed: " + note, AdapterPath: adapter, AdapterVersion: adapterVersion, EngineVersion: engineVersion}, nil
		} else if running {
			return NativeSkillReadiness{Harness: "codex", Reason: "A codex-acp process is active in this workspace", AdapterPath: adapter, AdapterVersion: adapterVersion, EngineVersion: engineVersion}, nil
		}
	}
	return NativeSkillReadiness{Harness: "codex", Ready: ready, Reason: reason, AdapterPath: adapter, AdapterVersion: adapterVersion, EngineVersion: engineVersion}, nil
}

// NativeSkillLoading uses the same readiness gate as publication, then starts
// the selected ACP adapter with an isolated offline home. It compares only the
// exact native discovery names from the node's verified placement receipt.
func (c *codexDescriptor) NativeSkillLoading(ctx context.Context, key string, expected []string) (skills.Observation, error) {
	if len(expected) == 0 {
		return skills.Observation{Reason: "No native skill names are selected for this placement"}, nil
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
		return skills.Observation{}, fmt.Errorf("fresh isolated Codex session could not establish discovery: %w", err)
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

// codexAdapterProcessRunning finds the selected adapter in command lines, then
// verifies that a matching process has a cwd within the target workspace. The
// adapter commonly runs under node, so checking a process name would miss it.
func codexAdapterProcessRunning(adapterPath, workspace string) (bool, string) {
	pattern := regexp.QuoteMeta(adapterPath)
	out, err := exec.Command("pgrep", "-f", pattern).Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
			return false, ""
		}
		return false, "process check unavailable (pgrep not found or failed)"
	}
	pids := strings.Fields(string(out))
	if len(pids) == 0 {
		return false, ""
	}
	lsofOut, err := exec.Command("lsof", "-a", "-p", strings.Join(pids, ","), "-d", "cwd", "-Fn").Output()
	if err != nil {
		return false, "process check unavailable (lsof not found or failed)"
	}
	for _, cwd := range parseLsofCwds(lsofOut) {
		if cwdWithinWorkspace(cwd, workspace) {
			return true, ""
		}
	}
	return false, ""
}

func codexAdapterPackage(resolved string) (string, string) {
	for dir, n := filepath.Dir(resolved), 0; n < 12; n++ {
		if version := packageVersion(filepath.Join(dir, "package.json"), "@agentclientprotocol/codex-acp"); version != "" {
			return dir, version
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", ""
}

func codexBundledEngineVersion(root string) string {
	for dir, n := root, 0; dir != "" && n < 12; n++ {
		if version := packageVersion(filepath.Join(dir, "node_modules", "@openai", "codex", "package.json"), "@openai/codex"); version != "" {
			return version
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// nativeSkillDiscoveryNode finds a usable Node executable for the isolated ACP
// probe. Node-agent services often have a smaller PATH than the operator's
// shell, while codex-acp's executable shim invokes `/usr/bin/env node`.
// Resolve the same supported locations as the adapter and prepend only the
// selected runtime directory to the disposable process's PATH.
func (c *codexDescriptor) nativeSkillDiscoveryNode() (string, error) {
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
	return "", fmt.Errorf("Codex loading evidence was not collected: a usable Node runtime could not be resolved for codex-acp")
}
