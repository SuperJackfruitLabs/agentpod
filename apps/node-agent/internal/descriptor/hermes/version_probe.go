package hermes

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
)

// hermesVersionTimeout bounds one `hermes --version` fallback. That command
// checks for updates, over the network and through a subprocess, before it
// exits, so it is given far longer than a plain version flag would need.
const hermesVersionTimeout = 10 * time.Second

// HermesVersion reports the version of the Hermes this node would run.
func HermesVersion(ctx context.Context) descriptor.VersionProbe {
	binary, ok := hostproc.ResolveNativeHarnessBinary("hermes")
	if !ok {
		binary = ""
	}
	return hermesVersionOf(ctx, binary)
}

// hermesVersionOf reads Hermes's version from the package metadata of the
// virtual environment its entry point lives in, and only falls back to running
// `hermes --version` when that metadata cannot be found. The entry point is a
// /bin/sh wrapper beside the venv's python, so the venv is found from the
// wrapper's real path, not from a shebang.
func hermesVersionOf(ctx context.Context, binary string) descriptor.VersionProbe {
	if binary == "" {
		return descriptor.VersionProbe{Status: descriptor.VersionAbsent, Reason: "The hermes executable is unresolved on this node"}
	}
	if version, ok := hermesPackageVersion(binary); ok {
		return descriptor.VersionProbe{Version: version, Status: descriptor.VersionKnown, Reason: "Read from the installed hermes-agent package metadata"}
	}
	probe := hostproc.ProbeVersion(ctx, hermesVersionTimeout, func(ctx context.Context) (string, error) {
		cmd := hostproc.HarnessCommand(ctx, binary, "--version")
		out, err := cmd.Output()
		if err != nil {
			return "", err
		}
		return parseHermesVersionBanner(out), nil
	})
	if probe.Status == descriptor.VersionKnown {
		probe.Reason = "Read from the first line of `hermes --version`"
	}
	return probe
}

var hermesDistInfoVersion = regexp.MustCompile(`(?m)^Version:\s*([0-9][^\s]*)\s*$`)

func hermesPackageVersion(binary string) (string, bool) {
	real, err := filepath.EvalSymlinks(binary)
	if err != nil {
		return "", false
	}
	venv := filepath.Dir(filepath.Dir(real))
	matches, err := filepath.Glob(filepath.Join(venv, "lib", "python*", "site-packages", "hermes_agent-*.dist-info", "METADATA"))
	if err != nil || len(matches) != 1 {
		// None, or more than one installed distribution: neither is an answer.
		return "", false
	}
	data, err := os.ReadFile(matches[0])
	if err != nil || len(data) > 1<<20 {
		return "", false
	}
	m := hermesDistInfoVersion.FindSubmatch(data)
	if m == nil {
		return "", false
	}
	return string(m[1]), true
}

var hermesBannerVersion = regexp.MustCompile(`\bv?([0-9]+\.[0-9]+\.[0-9]+)\b`)

// parseHermesVersionBanner reads only the first line of `hermes --version`
// ("Hermes Agent v0.21.5 (2026.9.24) …"). The rest is install detail and an
// update notice, and the whole banner can be long enough to trip a byte cap.
func parseHermesVersionBanner(out []byte) string {
	line, _, _ := bufio.NewReader(bytes.NewReader(out)).ReadLine()
	m := hermesBannerVersion.FindSubmatch(line)
	if m == nil {
		return ""
	}
	return string(m[1])
}
