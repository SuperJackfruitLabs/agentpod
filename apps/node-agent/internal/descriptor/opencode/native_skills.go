package opencode

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/acpskills"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// Versions whose fresh isolated ACP session was observed advertising a skill
// published at .opencode/skills/<name>/SKILL.md. Each entry is one probe that
// was actually run; a version absent here is refused rather than assumed to
// behave like a neighbour.
var openCodeDiscoveryEvidence = map[string]bool{"1.18.15": true, "1.18.30": true}

func openCodeSupportedVersions() string {
	versions := make([]string, 0, len(openCodeDiscoveryEvidence))
	for version := range openCodeDiscoveryEvidence {
		versions = append(versions, version)
	}
	sort.Strings(versions)
	return strings.Join(versions, ", ")
}

// Native placement fixture probes establish on-disk discovery for particular
// CLI versions. OpenCode also has a fresh ACP comparison and a process gate;
// Pi and OpenClaw remain closed until their ACP and quiescence evidence exists.
func (o *Descriptor) NativeSkillReadiness(ctx context.Context, key string) (descriptor.NativeSkillReadiness, error) {
	if _, err := o.projectPathForKey(key); err != nil {
		return descriptor.NativeSkillReadiness{}, err
	}
	if err := ctx.Err(); err != nil {
		return descriptor.NativeSkillReadiness{}, err
	}
	result := descriptor.NativeSkillReadiness{Harness: "opencode", Reason: "Selected OpenCode executable is unresolved"}
	binary, ok := hostproc.ResolveNativeHarnessBinary("opencode")
	if !ok {
		return result, nil
	}
	binary, err := filepath.Abs(binary)
	if err != nil {
		return result, nil
	}
	result.AdapterPath = binary
	versionProbe := hostproc.NativeExecutableVersionProbe(ctx, binary)
	result.EngineVersion = versionProbe.Version
	if result.EngineVersion == "" {
		result.Reason = hostproc.VersionUnavailableReason("Selected OpenCode", versionProbe)
	} else if !openCodeDiscoveryEvidence[result.EngineVersion] {
		result.Reason = fmt.Sprintf("OpenCode %s has no recorded native ACP discovery evidence; supported versions are %s", result.EngineVersion, openCodeSupportedVersions())
	} else if running, note := o.NativeProcessRunning(); note != "" {
		result.Reason = "OpenCode process inspection failed: " + note
	} else if running {
		result.Reason = "An OpenCode process is active; native publication requires a quiescent runtime"
	} else {
		result.Ready = true
		result.Reason = "OpenCode " + result.EngineVersion + " matches isolated ACP skill discovery evidence and no OpenCode process is active"
	}
	return result, nil
}

// NativeSkillLoading compares the exact names in the verified native receipt
// with a fresh, isolated ACP session. It does not refresh a user's active chat.
func (o *Descriptor) NativeSkillLoading(ctx context.Context, key string, expected []string) (skills.Observation, error) {
	if len(expected) == 0 {
		return skills.Observation{Reason: "No native skill names are selected for this placement"}, nil
	}
	readiness, err := o.NativeSkillReadiness(ctx, key)
	if err != nil {
		return skills.Observation{}, err
	}
	if !readiness.Ready {
		return skills.Observation{Reason: readiness.Reason}, nil
	}
	workspace, err := o.projectPathForKey(key)
	if err != nil {
		return skills.Observation{}, err
	}
	advertised, err := o.NativeSkillDiscovery(ctx, readiness.AdapterPath, workspace)
	if err != nil {
		return skills.Observation{}, fmt.Errorf("fresh isolated OpenCode session could not establish discovery: %w", err)
	}
	seen := make(map[string]bool, len(advertised))
	for _, name := range advertised {
		seen[name] = true
	}
	for _, name := range expected {
		if !seen[name] {
			return descriptor.ObservedNativeSkillLoading(false, "A fresh isolated OpenCode ACP session did not advertise "+name), nil
		}
	}
	return descriptor.ObservedNativeSkillLoading(true, "A fresh isolated OpenCode ACP session advertised every expected native skill name"), nil
}

func openCodeACPDiscoverSkills(ctx context.Context, binary, workspace string) ([]string, error) {
	root, err := os.MkdirTemp("", "agentpod-opencode-discovery-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(root)
	home := filepath.Join(root, "home")
	if err := os.Mkdir(home, 0700); err != nil {
		return nil, err
	}
	env := []string{
		"HOME=" + home,
		"PATH=/usr/bin:/bin",
		"OPENCODE_DISABLE_AUTOUPDATE=1",
		"OPENCODE_DISABLE_MODELS_FETCH=1",
		"OPENCODE_DISABLE_DEFAULT_PLUGINS=1",
		"OPENCODE_DISABLE_SHARE=1",
		"XDG_CONFIG_HOME=" + filepath.Join(root, "config"),
		"XDG_CACHE_HOME=" + filepath.Join(root, "cache"),
		"XDG_DATA_HOME=" + filepath.Join(root, "data"),
		"XDG_STATE_HOME=" + filepath.Join(root, "state"),
		`OPENCODE_CONFIG_CONTENT={"autoupdate":false,"share":"disabled","plugin":[]}`,
	}
	return acpskills.DiscoverACPSkillCommands(ctx, []string{binary, "acp"}, workspace, env, func(name string) (string, bool) {
		if name == "" || strings.ContainsAny(name, "/\\\x00\r\n") {
			return "", false
		}
		return name, true
	})
}
