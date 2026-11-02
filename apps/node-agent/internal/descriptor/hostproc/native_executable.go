package hostproc

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// NativeExecutableVersion measures the selected executable without starting a
// session. A bounded, single-line version is diagnostic evidence, not a native
// loading claim.
func NativeExecutableVersion(ctx context.Context, binary string) string {
	return NativeExecutableVersionProbe(ctx, binary).Version
}

// NativeExecutableVersionProbe is nativeExecutableVersion with its outcome: a
// query that timed out is retried once and, if it times out again, reported as
// undetermined rather than as a missing or unsupported harness.
func NativeExecutableVersionProbe(ctx context.Context, binary string) descriptor.VersionProbe {
	if !filepath.IsAbs(binary) || !IsExecutableFile(binary) {
		return descriptor.VersionProbe{Status: descriptor.VersionAbsent, Reason: "The executable is not an absolute path to an executable file"}
	}
	return ProbeVersion(ctx, 3*time.Second, func(ctx context.Context) (string, error) {
		// Through harnessCommand, which puts the binary's own directory on PATH:
		// a harness binary is frequently a script whose interpreter lives beside
		// it, and a service-started node inherits a PATH without that directory.
		out, err := HarnessCommand(ctx, binary, "--version").Output()
		if err != nil {
			return "", err
		}
		version := strings.TrimSpace(string(out))
		if len(version) == 0 || len(version) > 128 || strings.ContainsAny(version, "\r\n\x00") {
			return "", fmt.Errorf("the version output is not a single short line")
		}
		return version, nil
	})
}

// VersionUnavailableReason words a failed version probe for a readiness
// refusal. A timeout says "ask again"; it never says the harness is missing.
func VersionUnavailableReason(subject string, probe descriptor.VersionProbe) string {
	if probe.TimedOut {
		return subject + " version could not be determined in time (the query timed out twice); this is undetermined, not missing, so ask again"
	}
	if probe.Reason != "" {
		return subject + " version is unavailable: " + probe.Reason
	}
	return subject + " version is unavailable"
}

// ResolveNativeHarnessBinary resolves a harness executable for a native
// readiness check.
//
// PATH alone is not enough. A node started by launchd or systemd inherits a
// PATH that usually excludes the directories harnesses install into --
// /opt/homebrew/bin above all -- and `binaryLocator` already carries that
// knowledge for every other resolution in this package. These readiness paths
// called exec.LookPath directly, so OpenCode was refused as "unresolved" on a
// machine where it was installed and on PATH for the operator, while Hermes
// resolved only because /usr/local/bin happens to sit on the default PATH.
func ResolveNativeHarnessBinary(name string) (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return BinaryLocator{
		UserHome:     home,
		LookPath:     exec.LookPath,
		IsExecutable: IsExecutableFile,
	}.Locate(name, "")
}

func PackageVersionInParents(binary, name string) string {
	for dir, n := filepath.Dir(binary), 0; n < 12; n++ {
		if version := PackageVersion(filepath.Join(dir, "package.json"), name); version != "" {
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
