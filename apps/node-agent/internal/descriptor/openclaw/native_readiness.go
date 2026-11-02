package openclaw

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
)

// Versions whose skills directory was observed being read. Each entry is one
// probe that was actually run against an installed build: a fixture written to
// <home>/skills/<name>/SKILL.md, then `openclaw skills list --json` and
// `openclaw skills check`, then removal and the same two reports again.
//
// This gate was previously closed for every version with the reason that
// native publication "needs a gateway quiescence and ACP loading gate". That
// was an assumption rather than an observation, and the probe refuted it: the
// inventory is a directory scan performed per invocation, the placed skill was
// reported ready with no gateway running at all, and removing it dropped the
// count back. What remains true, and is kept above, is the REMOTE gateway
// case, which OpenClaw's documentation says never falls back to local skills.
//
// A version absent here is refused rather than assumed to behave like a
// neighbour.
var openClawDiscoveryEvidence = map[string]bool{
	"2026.2.12": true,
}

func openClawSupportedVersions() string {
	versions := make([]string, 0, len(openClawDiscoveryEvidence))
	for version := range openClawDiscoveryEvidence {
		versions = append(versions, version)
	}
	sort.Strings(versions)
	return strings.Join(versions, ", ")
}

func (o *Descriptor) NativeSkillReadiness(ctx context.Context, key string) (descriptor.NativeSkillReadiness, error) {
	if err := ctx.Err(); err != nil {
		return descriptor.NativeSkillReadiness{}, err
	}
	stations, err := o.Detect()
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
		return descriptor.NativeSkillReadiness{}, fmt.Errorf("openclaw: station not found: %q", key)
	}
	result := descriptor.NativeSkillReadiness{Harness: "openclaw", Reason: "Selected OpenClaw executable is unresolved"}
	binary, err := o.ResolveBinary()
	if err != nil {
		return result, nil
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		return result, nil
	}
	result.AdapterPath = binary
	if resolved, err := filepath.EvalSymlinks(binary); err == nil {
		result.EngineVersion = hostproc.PackageVersionInParents(resolved, "openclaw")
	}
	versionProbe := descriptor.VersionProbe{Status: descriptor.VersionKnown}
	if result.EngineVersion == "" {
		versionProbe = hostproc.NativeExecutableVersionProbe(ctx, binary)
		result.EngineVersion = versionProbe.Version
	}
	if result.EngineVersion == "" {
		result.Reason = hostproc.VersionUnavailableReason("Selected OpenClaw", versionProbe)
	} else if o.GatewayURL != "" {
		// A CONFIGURED REMOTE gateway is authoritative for its own inventory
		// and, per OpenClaw's own documentation, "never falls back to
		// client-local skills". Publishing into this node's skills directory
		// would place files nothing reads, so this stays refused. Only the
		// local case below was ever observable.
		result.Reason = "Configured remote OpenClaw gateway is authoritative for its skill inventory and does not read this node's skills directory"
	} else if !openClawDiscoveryEvidence[result.EngineVersion] {
		result.Reason = fmt.Sprintf("OpenClaw %s has no recorded native skill discovery evidence; supported versions are %s", result.EngineVersion, openClawSupportedVersions())
	} else {
		result.Ready = true
		result.Reason = "OpenClaw " + result.EngineVersion + " reports a skill placed in its skills directory as ready, and the report needs no gateway"
	}
	return result, nil
}
