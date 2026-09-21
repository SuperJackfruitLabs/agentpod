package descriptor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// nativeExecutableVersion measures the selected executable without starting a
// session. A bounded, single-line version is diagnostic evidence, not a native
// loading claim.
func nativeExecutableVersion(ctx context.Context, binary string) string {
	if !filepath.IsAbs(binary) || !isExecutableFile(binary) {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, binary, "--version").Output()
	if err != nil {
		return ""
	}
	version := strings.TrimSpace(string(out))
	if len(version) == 0 || len(version) > 128 || strings.ContainsAny(version, "\r\n\x00") {
		return ""
	}
	return version
}

// Native placement fixture probes establish on-disk discovery for particular
// CLI versions. OpenCode also has a fresh ACP comparison and a process gate;
// Pi and OpenClaw remain closed until their ACP and quiescence evidence exists.
func (o *openCodeDescriptor) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	if _, err := o.projectPathForKey(key); err != nil {
		return NativeSkillReadiness{}, err
	}
	if err := ctx.Err(); err != nil {
		return NativeSkillReadiness{}, err
	}
	result := NativeSkillReadiness{Harness: "opencode", Reason: "Selected OpenCode executable is unresolved"}
	binary, err := exec.LookPath("opencode")
	if err != nil {
		return result, nil
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		return result, nil
	}
	result.AdapterPath = binary
	result.EngineVersion = nativeExecutableVersion(ctx, binary)
	if result.EngineVersion == "" {
		result.Reason = "Selected OpenCode version is unavailable"
	} else if result.EngineVersion != "1.18.15" {
		result.Reason = fmt.Sprintf("OpenCode %s has no recorded native ACP discovery evidence; supported version is 1.18.15", result.EngineVersion)
	} else if running, note := o.nativeProcessRunning(); note != "" {
		result.Reason = "OpenCode process inspection failed: " + note
	} else if running {
		result.Reason = "An OpenCode process is active; native publication requires a quiescent runtime"
	} else {
		result.Ready = true
		result.Reason = "OpenCode 1.18.15 matches isolated ACP skill discovery evidence and no OpenCode process is active"
	}
	return result, nil
}

// NativeSkillLoading compares the exact names in the verified native receipt
// with a fresh offline ACP session. It does not refresh a user's active chat.
func (o *openCodeDescriptor) NativeSkillLoading(ctx context.Context, key string, expected []string) (skills.Observation, error) {
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
	advertised, err := o.nativeSkillDiscovery(ctx, readiness.AdapterPath, workspace)
	if err != nil {
		return skills.Observation{}, fmt.Errorf("fresh isolated OpenCode session could not establish discovery: %w", err)
	}
	seen := make(map[string]bool, len(advertised))
	for _, name := range advertised {
		seen[name] = true
	}
	for _, name := range expected {
		if !seen[name] {
			return observedNativeSkillLoading(false, "A fresh isolated OpenCode ACP session did not advertise "+name), nil
		}
	}
	return observedNativeSkillLoading(true, "A fresh isolated OpenCode ACP session advertised every native skill in this placement"), nil
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
		"XDG_CONFIG_HOME=" + filepath.Join(root, "config"),
		"XDG_CACHE_HOME=" + filepath.Join(root, "cache"),
		"XDG_DATA_HOME=" + filepath.Join(root, "data"),
		"XDG_STATE_HOME=" + filepath.Join(root, "state"),
		`OPENCODE_CONFIG_CONTENT={"autoupdate":false,"share":"disabled","plugin":[]}`,
	}
	return discoverACPSkillCommands(ctx, []string{binary, "acp"}, workspace, env, func(name string) (string, bool) {
		if name == "" || strings.ContainsAny(name, "/\\\x00\r\n") {
			return "", false
		}
		return name, true
	})
}

func (p *piDescriptor) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	if _, err := p.workspaceForKey(key); err != nil {
		return NativeSkillReadiness{}, err
	}
	if err := ctx.Err(); err != nil {
		return NativeSkillReadiness{}, err
	}
	result := NativeSkillReadiness{Harness: "pi", Reason: "Selected Pi or pi-acp executable is unresolved"}
	engine, engineOK := p.piBinary()
	adapter, adapterOK := p.acpAdapter()
	if !engineOK || !adapterOK {
		return result, nil
	}
	engine, engineErr := filepath.Abs(engine)
	adapter, adapterErr := filepath.Abs(adapter)
	if engineErr != nil || adapterErr != nil {
		return result, nil
	}
	result.AdapterPath = adapter
	result.EngineVersion = nativeExecutableVersion(ctx, engine)
	if resolved, err := filepath.EvalSymlinks(adapter); err == nil {
		result.AdapterVersion = packageVersionInParents(resolved, "pi-acp")
	}
	if result.EngineVersion == "" || result.AdapterVersion == "" {
		result.Reason = "Selected Pi engine or pi-acp package version is unavailable"
	} else {
		result.Reason = fmt.Sprintf("Pi %s through pi-acp %s has no recorded ACP skill-loading and external-process quiescence evidence for native placement", result.EngineVersion, result.AdapterVersion)
	}
	return result, nil
}

func (o *openclawDescriptor) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	if err := ctx.Err(); err != nil {
		return NativeSkillReadiness{}, err
	}
	stations, err := o.Detect()
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
		return NativeSkillReadiness{}, fmt.Errorf("openclaw: station not found: %q", key)
	}
	result := NativeSkillReadiness{Harness: "openclaw", Reason: "Selected OpenClaw executable is unresolved"}
	binary, err := o.resolveBinary()
	if err != nil {
		return result, nil
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		return result, nil
	}
	result.AdapterPath = binary
	if resolved, err := filepath.EvalSymlinks(binary); err == nil {
		result.EngineVersion = packageVersionInParents(resolved, "openclaw")
	}
	if result.EngineVersion == "" {
		result.EngineVersion = nativeExecutableVersion(ctx, binary)
	}
	if result.EngineVersion == "" {
		result.Reason = "Selected OpenClaw version is unavailable"
	} else if o.gatewayURL != "" {
		result.Reason = "Configured remote OpenClaw gateway cannot be made quiescent by this node"
	} else {
		result.Reason = fmt.Sprintf("OpenClaw %s uses a shared gateway; native publication needs a gateway quiescence and ACP loading gate", result.EngineVersion)
	}
	return result, nil
}

func packageVersionInParents(binary, name string) string {
	for dir, n := filepath.Dir(binary), 0; n < 12; n++ {
		if version := packageVersion(filepath.Join(dir, "package.json"), name); version != "" {
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
