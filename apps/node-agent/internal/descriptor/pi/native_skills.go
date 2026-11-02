package pi

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
)

func (p *Descriptor) NativeSkillReadiness(ctx context.Context, key string) (descriptor.NativeSkillReadiness, error) {
	if _, err := p.workspaceForKey(key); err != nil {
		return descriptor.NativeSkillReadiness{}, err
	}
	if err := ctx.Err(); err != nil {
		return descriptor.NativeSkillReadiness{}, err
	}
	result := descriptor.NativeSkillReadiness{Harness: "pi", Reason: "Selected Pi or pi-acp executable is unresolved"}
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
	engineProbe := hostproc.NativeExecutableVersionProbe(ctx, engine)
	result.EngineVersion = engineProbe.Version
	if resolved, err := filepath.EvalSymlinks(adapter); err == nil {
		result.AdapterVersion = hostproc.PackageVersionInParents(resolved, "pi-acp")
	}
	if result.EngineVersion == "" {
		result.Reason = hostproc.VersionUnavailableReason("Selected Pi engine", engineProbe)
		return result, nil
	}
	if result.AdapterVersion == "" {
		result.Reason = "Selected pi-acp package version is unavailable"
		return result, nil
	}
	// This engine is the one whose fresh isolated session was observed
	// advertising skill:<id> for a skill published under .pi/skills, once the
	// run trusted project files. Another engine has no such evidence.
	if !piDiscoveryEvidence[result.EngineVersion] {
		result.Reason = fmt.Sprintf("Pi %s through pi-acp %s has no recorded ACP skill discovery evidence", result.EngineVersion, result.AdapterVersion)
		return result, nil
	}
	if running, note := piProcessRunning(); note != "" {
		result.Reason = "Pi process inspection failed: " + note
		return result, nil
	} else if running {
		result.Reason = "A Pi process is active on this host"
		return result, nil
	}
	result.Ready = true
	result.Reason = fmt.Sprintf("Pi %s through pi-acp %s matches isolated ACP discovery evidence; project trust remains the operator's decision and an untrusting session will not load a placed skill", result.EngineVersion, result.AdapterVersion)
	return result, nil
}

// Engines whose fresh isolated ACP session was observed advertising a skill
// published under .pi/skills. A version absent here is refused rather than
// assumed to behave like a neighbour.
var piDiscoveryEvidence = map[string]bool{"0.84.1": true}

// piProcessRunning reports whether any Pi process is active. Pi has no daemon
// and is invoked per command, so this is a coarse guard against publishing
// underneath a command that is mid-run.
func piProcessRunning() (bool, string) {
	return hostproc.ProcessRunningInWorkspace("^pi$", "/")
}
