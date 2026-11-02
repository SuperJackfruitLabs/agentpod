package pi

import (
	"context"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
)

// PiVersion reports the version of the Pi this node would run, from
// `pi --version` (a single line, e.g. "0.84.1").
func PiVersion(ctx context.Context) descriptor.VersionProbe {
	binary, ok := hostproc.ResolveNativeHarnessBinary("pi")
	if !ok {
		return descriptor.VersionProbe{Status: descriptor.VersionAbsent, Reason: "The pi executable is unresolved on this node"}
	}
	return hostproc.NativeExecutableVersionProbe(ctx, binary)
}
