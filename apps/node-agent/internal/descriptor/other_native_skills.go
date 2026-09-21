package descriptor

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
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

// These preflights deliberately report Ready=false. Native placement fixture
// probes establish on-disk discovery for particular CLI versions; they do not
// establish that the selected ACP session exposes the same skill, or that a
// shared gateway and external processes are quiescent during publication.
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
	} else {
		result.Reason = fmt.Sprintf("OpenCode %s has no recorded ACP loading and external-process quiescence evidence for native placement", result.EngineVersion)
	}
	return result, nil
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
