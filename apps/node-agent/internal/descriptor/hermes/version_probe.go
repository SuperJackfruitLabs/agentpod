package hermes

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
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
	if version, distInfo, ok := hermesPackageVersion(binary); ok {
		if version == editablePlaceholderVersion {
			if tagged, checkout, ok := hermesCheckoutTag(ctx, distInfo); ok {
				return descriptor.VersionProbe{Version: tagged, Status: descriptor.VersionKnown,
					Reason: "Read from the release tag of the editable git checkout at " + checkout}
			}
		}
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

func hermesPackageVersion(binary string) (string, string, bool) {
	real, err := filepath.EvalSymlinks(binary)
	if err != nil {
		return "", "", false
	}
	venv := filepath.Dir(filepath.Dir(real))
	matches, err := filepath.Glob(filepath.Join(venv, "lib", "python*", "site-packages", "hermes_agent-*.dist-info", "METADATA"))
	if err != nil || len(matches) != 1 {
		// None, or more than one installed distribution: neither is an answer.
		return "", "", false
	}
	data, err := os.ReadFile(matches[0])
	if err != nil || len(data) > 1<<20 {
		return "", "", false
	}
	m := hermesDistInfoVersion.FindSubmatch(data)
	if m == nil {
		return "", "", false
	}
	return string(m[1]), filepath.Dir(matches[0]), true
}

// editablePlaceholderVersion is what Hermes's own pyproject declares. A wheel
// build stamps the release over it; an editable install from a git checkout
// (Hermes's own installer's "git" method) keeps it, so the metadata names no
// release at all.
const editablePlaceholderVersion = "0.0.0"

// hermesGitTimeout bounds the one `git describe` an editable install needs.
const hermesGitTimeout = 5 * time.Second

var hermesReleaseTag = regexp.MustCompile(`^v?([0-9]+\.[0-9]+\.[0-9]+)$`)

// hermesCheckoutTag reads the release of an editable install from its source
// checkout: the checkout PEP 610's direct_url.json names, only when HEAD is
// exactly a release tag and the tracked files are unchanged. A commit between
// tags, or a locally edited tree, is not a release anyone tested, so it stays
// unanswered and the caller reports the metadata's placeholder.
func hermesCheckoutTag(ctx context.Context, distInfo string) (string, string, bool) {
	data, err := os.ReadFile(filepath.Join(distInfo, "direct_url.json"))
	if err != nil || len(data) > 64<<10 {
		return "", "", false
	}
	var direct struct {
		URL     string `json:"url"`
		DirInfo struct {
			Editable bool `json:"editable"`
		} `json:"dir_info"`
	}
	if json.Unmarshal(data, &direct) != nil || !direct.DirInfo.Editable {
		return "", "", false
	}
	u, err := url.Parse(direct.URL)
	if err != nil || u.Scheme != "file" || (u.Host != "" && u.Host != "localhost") || !filepath.IsAbs(u.Path) || filepath.Clean(u.Path) != u.Path {
		return "", "", false
	}
	checkout := u.Path
	ctx, cancel := context.WithTimeout(ctx, hermesGitTimeout)
	defer cancel()
	// The checkout is often another user's (root's, under /opt), and git
	// refuses to read a repository its caller does not own unless told this one
	// is safe. Only that one directory is named, and only for this read.
	cmd := exec.CommandContext(ctx, "git", "-c", "safe.directory="+checkout, "-C", checkout,
		"describe", "--tags", "--exact-match", "--dirty")
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		return "", "", false
	}
	m := hermesReleaseTag.FindStringSubmatch(strings.TrimSpace(string(out)))
	if m == nil {
		return "", "", false
	}
	return m[1], checkout, true
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
