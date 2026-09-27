package descriptor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// A version probe has three honest outcomes, and a gate must be able to tell
// them apart:
//
//   - known: the version was read.
//   - absent: there is no such harness here to ask.
//   - undetermined: something is here, but its version could not be read this
//     time. A probe that ran out of time lands here, never in the other two;
//     treating a slow cold start as a missing or out-of-range harness is how a
//     canary once read a working Pi as "version unavailable".
const (
	VersionKnown        = "known"
	VersionAbsent       = "absent"
	VersionUndetermined = "undetermined"
)

// VersionProbe is one observation of a harness version. It is never cached as
// a verdict: undetermined means "ask again", not "no".
type VersionProbe struct {
	Version  string `json:"version,omitempty"`
	Status   string `json:"status"`
	Reason   string `json:"reason"`
	TimedOut bool   `json:"timedOut,omitempty"`
}

// probeVersion runs one version query under its own deadline and retries it
// once when, and only when, that deadline expired. The overall bound stays
// finite (at most two deadlines), so a stalled mount still cannot wedge the
// caller; a query that failed for any other reason is not retried, because
// running it again would only repeat the answer.
func probeVersion(ctx context.Context, timeout time.Duration, query func(context.Context) (string, error)) VersionProbe {
	var last VersionProbe
	for attempt := 0; attempt < 2; attempt++ {
		if err := ctx.Err(); err != nil {
			return VersionProbe{Status: VersionUndetermined, Reason: "The version query was cancelled: " + err.Error()}
		}
		attemptCtx, cancel := context.WithTimeout(ctx, timeout)
		version, err := query(attemptCtx)
		timedOut := errors.Is(attemptCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
		cancel()
		version = strings.TrimSpace(version)
		if err == nil && version != "" {
			return VersionProbe{Version: version, Status: VersionKnown, Reason: "Read the installed version"}
		}
		if !timedOut {
			reason := "The version query returned no version"
			if err != nil {
				reason = "The version query failed: " + err.Error()
			}
			return VersionProbe{Status: VersionUndetermined, Reason: reason}
		}
		last = VersionProbe{Status: VersionUndetermined, TimedOut: true,
			Reason: fmt.Sprintf("The version query did not answer within %s, twice; the version is undetermined, not missing", timeout)}
	}
	return last
}

// hermesVersionTimeout bounds one `hermes --version` fallback. That command
// checks for updates, over the network and through a subprocess, before it
// exits, so it is given far longer than a plain version flag would need.
const hermesVersionTimeout = 10 * time.Second

// HermesVersion reports the version of the Hermes this node would run.
func HermesVersion(ctx context.Context) VersionProbe {
	binary, ok := resolveNativeHarnessBinary("hermes")
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
func hermesVersionOf(ctx context.Context, binary string) VersionProbe {
	if binary == "" {
		return VersionProbe{Status: VersionAbsent, Reason: "The hermes executable is unresolved on this node"}
	}
	if version, ok := hermesPackageVersion(binary); ok {
		return VersionProbe{Version: version, Status: VersionKnown, Reason: "Read from the installed hermes-agent package metadata"}
	}
	probe := probeVersion(ctx, hermesVersionTimeout, func(ctx context.Context) (string, error) {
		cmd := harnessCommand(ctx, binary, "--version")
		out, err := cmd.Output()
		if err != nil {
			return "", err
		}
		return parseHermesVersionBanner(out), nil
	})
	if probe.Status == VersionKnown {
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

// openclawVersionTimeout bounds one `openclaw --version` fallback. The CLI is
// a Node program with a large module graph; a cold start takes seconds.
const openclawVersionTimeout = 10 * time.Second

// OpenClawVersion reports the version of the OpenClaw this node would run.
func OpenClawVersion(ctx context.Context) VersionProbe {
	binary, ok := resolveNativeHarnessBinary("openclaw")
	if !ok {
		binary = ""
	}
	return openclawVersionOf(ctx, binary)
}

// openclawVersionOf reads the version from the npm package the binary links
// into (bin/openclaw → <pkg>/openclaw.mjs, beside <pkg>/package.json), and
// only runs `openclaw --version` when that cannot be found.
func openclawVersionOf(ctx context.Context, binary string) VersionProbe {
	if binary == "" {
		return VersionProbe{Status: VersionAbsent, Reason: "The openclaw executable is unresolved on this node"}
	}
	if real, err := filepath.EvalSymlinks(binary); err == nil {
		if raw, err := os.ReadFile(filepath.Join(filepath.Dir(real), "package.json")); err == nil {
			var pkg struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			}
			if json.Unmarshal(raw, &pkg) == nil && pkg.Name == "openclaw" && pkg.Version != "" {
				return VersionProbe{Version: pkg.Version, Status: VersionKnown, Reason: "Read from the installed openclaw package.json"}
			}
		}
	}
	return probeVersion(ctx, openclawVersionTimeout, func(ctx context.Context) (string, error) {
		out, err := harnessCommand(ctx, binary, "--version").Output()
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(out)), nil
	})
}

// PiVersion reports the version of the Pi this node would run, from
// `pi --version` (a single line, e.g. "0.84.1").
func PiVersion(ctx context.Context) VersionProbe {
	binary, ok := resolveNativeHarnessBinary("pi")
	if !ok {
		return VersionProbe{Status: VersionAbsent, Reason: "The pi executable is unresolved on this node"}
	}
	return nativeExecutableVersionProbe(ctx, binary)
}
