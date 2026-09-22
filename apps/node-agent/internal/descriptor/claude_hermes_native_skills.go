package descriptor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// These diagnostics describe the runtime a new station session would select.
// Neither harness has verified native placement or station-specific loading,
// so a resolved binary is never treated as permission to publish a skill.
func (c *claudeCodeDescriptor) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	workspace, err := c.projectPathForKey(key)
	if err != nil {
		return NativeSkillReadiness{}, err
	}
	if err := ctx.Err(); err != nil {
		return NativeSkillReadiness{}, err
	}
	result := NativeSkillReadiness{Harness: c.Harness(), Reason: "Claude native placement and station-specific fresh-session loading are not verified"}
	argv, _, _, err := c.ACPCommand(key)
	if err != nil {
		result.Reason = "Claude ACP runtime is unavailable: " + err.Error()
		return result, nil
	}
	if len(argv) != 1 {
		result.Reason = "Claude ACP would use npx; the installed adapter identity is unverified"
		return result, nil
	}
	if !filepath.IsAbs(argv[0]) {
		result.Reason = "Claude ACP adapter path is not absolute; its installed identity is unverified"
		return result, nil
	}
	result.AdapterPath = argv[0]
	if resolved, err := filepath.EvalSymlinks(argv[0]); err == nil {
		for dir, n := filepath.Dir(resolved), 0; n < 12; n++ {
			if version := packageVersion(filepath.Join(dir, "package.json"), "@agentclientprotocol/claude-agent-acp"); version != "" {
				result.AdapterVersion = version
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	claude, ok := c.locator().locate("claude", c.claudeBinary)
	if !ok {
		result.Reason = "The claude CLI is unresolved, so the engine a session would start has no identity"
		return result, nil
	}
	result.EngineVersion = nativeRuntimeVersion(ctx, claude)
	if result.EngineVersion == "" {
		result.Reason = "The claude CLI version is unavailable"
		return result, nil
	}
	// The pair below is the one an isolated fresh-session probe was run
	// against: adapter 0.66.0 started a session under a disposable HOME with
	// no authentication and advertised a skill published at
	// .claude/skills/<name>/SKILL.md, while a workspace without that
	// directory did not advertise it. Any other pair has no such evidence and
	// stays closed rather than being assumed equivalent.
	if result.AdapterVersion != "0.66.0" || !strings.HasPrefix(result.EngineVersion, "2.1.") {
		result.Reason = fmt.Sprintf("Adapter %s and engine %s have no recorded native discovery evidence", result.AdapterVersion, result.EngineVersion)
		return result, nil
	}
	// Publishing into a workspace a session is reading can change what that
	// session sees mid-run, so a live session closes the gate.
	if running, note := claudeProcessRunning(workspace); note != "" {
		result.Reason = "Claude process inspection failed: " + note
		return result, nil
	} else if running {
		result.Reason = "A Claude session is active in this workspace"
		return result, nil
	}
	result.Ready = true
	result.Reason = "Adapter and engine match isolated native discovery evidence; external-process quiescence is still required"
	return result, nil
}

func (h *hermesDescriptor) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	if err := ctx.Err(); err != nil {
		return NativeSkillReadiness{}, err
	}
	stations, err := h.Detect()
	if err != nil {
		return NativeSkillReadiness{}, err
	}
	found := false
	for _, station := range stations {
		if station.Key == key {
			found = true
			break
		}
	}
	if !found {
		return NativeSkillReadiness{}, os.ErrNotExist
	}
	result := NativeSkillReadiness{Harness: h.Harness(), Reason: "Hermes project-skill trust, scan verdict, and fresh-session loading are not verified for this station"}
	if binary, err := exec.LookPath("hermes"); err == nil {
		result.AdapterPath = binary
		result.EngineVersion = nativeRuntimeVersion(ctx, binary)
	} else {
		result.Reason = "Hermes executable is unavailable on the node service PATH"
	}
	return result, nil
}

func nativeRuntimeVersion(ctx context.Context, binary string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, binary, "--version").Output()
	if err != nil || len(out) > 256 {
		return ""
	}
	return strings.TrimSpace(string(out))
}
