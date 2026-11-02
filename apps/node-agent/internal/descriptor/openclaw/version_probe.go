package openclaw

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
)

// openclawVersionTimeout bounds one `openclaw --version` fallback. The CLI is
// a Node program with a large module graph; a cold start takes seconds.
const openclawVersionTimeout = 10 * time.Second

// OpenClawVersion reports the version of the OpenClaw this node would run.
func OpenClawVersion(ctx context.Context) descriptor.VersionProbe {
	binary, ok := hostproc.ResolveNativeHarnessBinary("openclaw")
	if !ok {
		binary = ""
	}
	return openclawVersionOf(ctx, binary)
}

// openclawVersionOf reads the version from the npm package the binary links
// into (bin/openclaw → <pkg>/openclaw.mjs, beside <pkg>/package.json), and
// only runs `openclaw --version` when that cannot be found.
func openclawVersionOf(ctx context.Context, binary string) descriptor.VersionProbe {
	if binary == "" {
		return descriptor.VersionProbe{Status: descriptor.VersionAbsent, Reason: "The openclaw executable is unresolved on this node"}
	}
	if real, err := filepath.EvalSymlinks(binary); err == nil {
		if raw, err := os.ReadFile(filepath.Join(filepath.Dir(real), "package.json")); err == nil {
			var pkg struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			}
			if json.Unmarshal(raw, &pkg) == nil && pkg.Name == "openclaw" && pkg.Version != "" {
				return descriptor.VersionProbe{Version: pkg.Version, Status: descriptor.VersionKnown, Reason: "Read from the installed openclaw package.json"}
			}
		}
	}
	return hostproc.ProbeVersion(ctx, openclawVersionTimeout, func(ctx context.Context) (string, error) {
		out, err := hostproc.HarnessCommand(ctx, binary, "--version").Output()
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(out)), nil
	})
}
