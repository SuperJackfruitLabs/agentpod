package hermes

import (
	"context"
	"fmt"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
)

func (h *Descriptor) NativeSkillReadiness(ctx context.Context, key string) (descriptor.NativeSkillReadiness, error) {
	if err := ctx.Err(); err != nil {
		return descriptor.NativeSkillReadiness{}, err
	}
	stations, err := h.Detect()
	if err != nil {
		return descriptor.NativeSkillReadiness{}, err
	}
	found := false
	for _, station := range stations {
		if station.Key == key {
			found = true
			break
		}
	}
	if !found {
		return descriptor.NativeSkillReadiness{}, os.ErrNotExist
	}
	result := descriptor.NativeSkillReadiness{Harness: h.Harness(), Reason: "Hermes native placement is not verified for this station"}
	binary, ok := hostproc.ResolveNativeHarnessBinary("hermes")
	if !ok {
		result.Reason = "The hermes executable is unresolved on this node"
		return result, nil
	}
	result.AdapterPath = binary
	// Read from the installed package, not from `hermes --version`, which
	// checks for updates over the network before it answers.
	hermesProbe := hermesVersionOf(ctx, binary)
	result.EngineVersion = hermesProbe.Version
	if result.EngineVersion == "" {
		result.Reason = hostproc.VersionUnavailableReason("The Hermes", hermesProbe) + ", so the runtime a session would use has no identity"
		return result, nil
	}
	// The version below is the one a disposable profile was probed on: a skill
	// published to the managed directory reported as absent until
	// skills.external_dirs named it, and as enabled afterwards. Another
	// version has no such evidence and stays closed rather than being assumed
	// equivalent.
	if result.EngineVersion != "0.21.3" {
		result.Reason = fmt.Sprintf("Hermes %s has no recorded native placement evidence", result.EngineVersion)
		return result, nil
	}
	// A profile whose gateway is up is reading its own configuration and skill
	// directories, so publishing into it can change what a live agent sees.
	if running, err := hermesProcessRunning(key); err != nil {
		result.Reason = "Hermes process inspection failed: " + err.Error()
		return result, nil
	} else if running {
		result.Reason = "A Hermes gateway is running for this profile"
		return result, nil
	}
	result.Ready = true
	result.Reason = "Hermes version matches recorded native placement evidence and no gateway is running for this profile; registration in skills.external_dirs remains a separate reviewed operation"
	return result, nil
}
