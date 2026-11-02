package hostproc

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

func nativeRuntimeVersion(ctx context.Context, binary string) string {
	return NativeRuntimeVersionProbe(ctx, binary).Version
}

// NativeRuntimeVersionProbe is nativeRuntimeVersion with its outcome, retrying
// a timed-out query once.
func NativeRuntimeVersionProbe(ctx context.Context, binary string) descriptor.VersionProbe {
	return ProbeVersion(ctx, 5*time.Second, func(ctx context.Context) (string, error) {
		out, err := exec.CommandContext(ctx, binary, "--version").Output()
		if err != nil {
			return "", err
		}
		if len(out) > 256 {
			return "", fmt.Errorf("the version output is longer than 256 bytes")
		}
		return strings.TrimSpace(string(out)), nil
	})
}
