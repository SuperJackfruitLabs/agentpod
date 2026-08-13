// Package selfupdate implements the node-agent self-update mechanism.
// It resolves the latest GitHub release, downloads the versioned binary,
// verifies its SHA-256 checksum, atomically swaps it in place, and restarts
// the systemd service (user or system scope auto-detected).
package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/service"
)

// ErrRestartFailed is returned when the service restart command fails.
// The binary has already been swapped; the caller should print a manual hint.
var ErrRestartFailed = errors.New("selfupdate: service restart failed")

// Options configures an Update call. Zero values are replaced with safe defaults.
type Options struct {
	CurrentVersion string
	Force          bool
	CheckOnly      bool
	APIBase        string // default: https://api.github.com
	DLBase         string // default: https://github.com
	HTTPClient     *http.Client
	RunCommand     func(name string, args ...string) error

	// targetPathForTest overrides os.Executable + EvalSymlinks resolution.
	// Used exclusively in unit tests; leave zero in production.
	targetPathForTest string
}

// Result describes what Update did.
type Result struct {
	CurrentVersion string
	LatestTag      string
	Updated        bool
	Reason         string
}

// parseSHA256SUMS parses a SHA256SUMS file (lines "<hex>  <filename>") and
// returns the expected hex digest for asset. Returns an error when the asset
// is not listed or any line is malformed.
func parseSHA256SUMS(data []byte, asset string) (string, error) {
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return "", fmt.Errorf("selfupdate: malformed SHA256SUMS line: %q", line)
		}
		if fields[1] == asset {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("selfupdate: asset %q not found in SHA256SUMS", asset)
}

// assetName returns the release asset filename for the given GOOS/GOARCH.
func assetName(goos, goarch string) string {
	return fmt.Sprintf("agentpod-node-%s-%s", goos, goarch)
}

// LatestTag fetches the latest GitHub release tag for agentpod/agentpod.
// apiBase defaults to "https://api.github.com" when empty.
func LatestTag(ctx context.Context, client *http.Client, apiBase string) (string, error) {
	if client == nil {
		client = http.DefaultClient
	}
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	url := apiBase + "/repos/rakeshgangwar/agentpod/releases/latest"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("selfupdate: GitHub API returned %d for %s", resp.StatusCode, url)
	}
	var payload struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("selfupdate: decode releases/latest: %w", err)
	}
	if payload.TagName == "" {
		return "", fmt.Errorf("selfupdate: empty tag_name in releases/latest response")
	}
	return payload.TagName, nil
}

// downloadAndVerify downloads the release asset binary to a temp file in
// destDir, downloads SHA256SUMS from the same release, verifies the digest,
// and returns the temp file path. On mismatch or error the temp file is
// deleted before returning.
func downloadAndVerify(ctx context.Context, client *http.Client, dlBase, tag, asset, destDir string) (string, error) {
	if client == nil {
		client = http.DefaultClient
	}
	if dlBase == "" {
		dlBase = "https://github.com"
	}

	// Create temp file before downloading so we can clean it up on any error.
	tmp, err := os.CreateTemp(destDir, "agentpod-node-*.tmp")
	if err != nil {
		return "", fmt.Errorf("selfupdate: create temp: %w", err)
	}
	tmpPath := tmp.Name()

	cleanup := func() {
		tmp.Close()
		os.Remove(tmpPath)
	}

	// Download the binary and compute its SHA-256 in one pass.
	assetURL := fmt.Sprintf("%s/rakeshgangwar/agentpod/releases/download/%s/%s", dlBase, tag, asset)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, assetURL, nil)
	if err != nil {
		cleanup()
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		cleanup()
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		cleanup()
		return "", fmt.Errorf("selfupdate: download %s returned %d", assetURL, resp.StatusCode)
	}

	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), resp.Body); err != nil {
		cleanup()
		return "", fmt.Errorf("selfupdate: write asset: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("selfupdate: close temp: %w", err)
	}
	gotHex := hex.EncodeToString(h.Sum(nil))

	// Download SHA256SUMS.
	sumsURL := fmt.Sprintf("%s/rakeshgangwar/agentpod/releases/download/%s/SHA256SUMS", dlBase, tag)
	req2, err := http.NewRequestWithContext(ctx, http.MethodGet, sumsURL, nil)
	if err != nil {
		os.Remove(tmpPath)
		return "", err
	}
	resp2, err := client.Do(req2)
	if err != nil {
		os.Remove(tmpPath)
		return "", err
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		os.Remove(tmpPath)
		return "", fmt.Errorf("selfupdate: SHA256SUMS download returned %d", resp2.StatusCode)
	}
	sumsData, err := io.ReadAll(resp2.Body)
	if err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("selfupdate: read SHA256SUMS: %w", err)
	}

	wantHex, err := parseSHA256SUMS(sumsData, asset)
	if err != nil {
		os.Remove(tmpPath)
		return "", err
	}

	if gotHex != wantHex {
		os.Remove(tmpPath)
		return "", fmt.Errorf("selfupdate: checksum mismatch for %s: got %s, want %s", asset, gotHex, wantHex)
	}

	return tmpPath, nil
}

// swapBinary atomically replaces targetPath with tmpPath.
// The previous binary is preserved as targetPath+".bak" for manual rollback.
// On rename failure the .bak is restored and the error is returned.
func swapBinary(targetPath, tmpPath string) error {
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return fmt.Errorf("selfupdate: chmod new binary: %w", err)
	}
	// Backup existing binary (ignore error when target doesn't exist yet).
	_ = os.Rename(targetPath, targetPath+".bak")
	if err := os.Rename(tmpPath, targetPath); err != nil {
		// Attempt rollback — restore the backup.
		_ = os.Rename(targetPath+".bak", targetPath)
		return fmt.Errorf("selfupdate: rename new binary into place: %w", err)
	}
	return nil
}

// restartService restarts the agentpod-node service for the given GOOS by
// delegating to the internal/service package's platform managers.
//
// linux: probes for a user-scoped systemd unit first; if active uses --user,
// else the system unit. darwin: the installer runs the agent as the LaunchAgent
// gui/<uid>/dev.agentpod.node — kickstart -k kills and restarts it. Returns a
// wrapped ErrRestartFailed when manager selection or the restart command
// fails (the binary is already swapped at that point).
func restartService(goos string, run func(name string, args ...string) error) error {
	if run == nil {
		run = func(name string, args ...string) error {
			return exec.Command(name, args...).Run()
		}
	}
	runner := func(name string, args ...string) (string, error) {
		return "", run(name, args...)
	}
	mgr, err := service.NewManagerForRestart(goos, runner)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrRestartFailed, err)
	}
	if err := mgr.Restart(); err != nil {
		return fmt.Errorf("%w: %v", ErrRestartFailed, err)
	}
	return nil
}

// applyTag downloads, verifies, and atomically swaps the binary for the given
// release tag. It does NOT restart the service; callers are responsible for
// that. This is the shared implementation for both Update and Apply.
func applyTag(ctx context.Context, opts Options, tag string) (Result, error) {
	// Resolve the live binary path (handles symlinks such as the "apn" wrapper).
	var targetPath string
	if opts.targetPathForTest != "" {
		targetPath = opts.targetPathForTest
	} else {
		exe, err := os.Executable()
		if err != nil {
			return Result{}, fmt.Errorf("selfupdate: resolve executable: %w", err)
		}
		targetPath, err = filepath.EvalSymlinks(exe)
		if err != nil {
			return Result{}, fmt.Errorf("selfupdate: eval symlinks: %w", err)
		}
	}
	targetDir := filepath.Dir(targetPath)

	asset := assetName(runtime.GOOS, runtime.GOARCH)

	tmpPath, err := downloadAndVerify(ctx, opts.HTTPClient, opts.DLBase, tag, asset, targetDir)
	if err != nil {
		return Result{}, err
	}

	if err := swapBinary(targetPath, tmpPath); err != nil {
		return Result{}, err
	}

	return Result{
		CurrentVersion: opts.CurrentVersion,
		LatestTag:      tag,
		Updated:        true,
	}, nil
}

// upToDate reports whether the running version is at or ahead of tag, i.e.
// whether applying tag would be pointless work.
//
// A version the comparator cannot read (the default build stamps the literal
// "dev", and the pre-`update`-verb agents in the fleet report nothing at all)
// is deliberately NOT up to date: refusing to update because the version is
// unreadable would strand exactly the nodes most in need of an update.
func upToDate(currentVersion, tag string) bool {
	cmp, err := CompareVersions(currentVersion, tag)
	return err == nil && cmp >= 0
}

// Apply resolves the latest GitHub release tag and, unless the node is already
// running it, downloads, verifies, and atomically swaps the binary. It does
// NOT restart the service — the caller is responsible for exiting so that the
// supervisor (e.g. systemd Restart=always) can start the new binary.
//
// The version comparison lives HERE, on the node, rather than in the hub that
// triggers the update (issue #296). The node is the only authority on which
// binary is actually running: the hub's agent_version column is whatever the
// node last reported, it is empty for exactly the stale agents this matters
// for, and it can go out of date between the hub deciding and the node acting.
// Deciding here also means every trigger of an update — the hub's button, a
// future bulk rollout, `agentpod-node update` — gets the same answer.
//
// Callers MUST branch on Result.Updated: when it is false nothing was swapped,
// so restarting the process buys nothing and costs the node its uptime (on Fly
// a restart is a full VM reboot). Options.Force re-applies the current release
// anyway, which is the escape hatch for a corrupt binary on a current version.
func Apply(ctx context.Context, opts Options) (Result, error) {
	// Apply defaults.
	if opts.HTTPClient == nil {
		opts.HTTPClient = http.DefaultClient
	}
	if opts.APIBase == "" {
		opts.APIBase = "https://api.github.com"
	}
	if opts.DLBase == "" {
		opts.DLBase = "https://github.com"
	}

	tag, err := LatestTag(ctx, opts.HTTPClient, opts.APIBase)
	if err != nil {
		return Result{}, err
	}

	res := Result{
		CurrentVersion: opts.CurrentVersion,
		LatestTag:      tag,
	}

	if !opts.Force && upToDate(opts.CurrentVersion, tag) {
		res.Reason = "already up to date"
		return res, nil
	}

	if opts.CheckOnly {
		res.Reason = "check only"
		return res, nil
	}

	return applyTag(ctx, opts, tag)
}

// Update orchestrates a full self-update: resolve latest tag, compare to
// current version, download+verify the binary, swap it in, restart the service.
//
// It is Apply plus the restart, and shares Apply's up-to-date short-circuit so
// the CLI path and the hub-triggered path can never disagree about whether an
// update is needed.
func Update(ctx context.Context, opts Options) (Result, error) {
	if opts.RunCommand == nil {
		opts.RunCommand = func(name string, args ...string) error {
			return exec.Command(name, args...).Run()
		}
	}

	res, err := Apply(ctx, opts)
	if err != nil {
		return Result{}, err
	}
	if !res.Updated {
		// Nothing was swapped (already current, or CheckOnly) — there is
		// nothing for a restart to pick up.
		return res, nil
	}

	// Restart the service. Even if this fails the binary has been updated.
	if err := restartService(runtime.GOOS, opts.RunCommand); err != nil {
		return res, err
	}

	return res, nil
}
