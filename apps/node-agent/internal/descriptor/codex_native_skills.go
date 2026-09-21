package descriptor

import (
	"context"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
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
