package descriptor

import (
	"context"
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
	if _, err := c.projectPathForKey(key); err != nil {
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
	if claude, ok := c.locator().locate("claude", c.claudeBinary); ok {
		result.EngineVersion = nativeRuntimeVersion(ctx, claude)
	}
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
