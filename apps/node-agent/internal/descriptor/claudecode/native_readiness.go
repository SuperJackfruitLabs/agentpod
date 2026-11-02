package claudecode

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
)

// These diagnostics describe the runtime a new station session would select.
// Neither harness has verified native placement or station-specific loading,
// so a resolved binary is never treated as permission to publish a skill.
func (c *Descriptor) NativeSkillReadiness(ctx context.Context, key string) (descriptor.NativeSkillReadiness, error) {
	workspace, err := c.projectPathForKey(key)
	if err != nil {
		return descriptor.NativeSkillReadiness{}, err
	}
	if err := ctx.Err(); err != nil {
		return descriptor.NativeSkillReadiness{}, err
	}
	result := descriptor.NativeSkillReadiness{Harness: c.Harness(), Reason: "Claude native placement and station-specific fresh-session loading are not verified"}
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
			if version := hostproc.PackageVersion(filepath.Join(dir, "package.json"), "@agentclientprotocol/claude-agent-acp"); version != "" {
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
	claude, ok := c.locator().Locate("claude", c.claudeBinary)
	if !ok {
		result.Reason = "The claude CLI is unresolved, so the engine a session would start has no identity"
		return result, nil
	}
	claudeProbe := hostproc.NativeRuntimeVersionProbe(ctx, claude)
	result.EngineVersion = claudeProbe.Version
	if result.EngineVersion == "" {
		result.Reason = hostproc.VersionUnavailableReason("The claude CLI", claudeProbe)
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
