package salaam

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"
)

// Runtime is operator-reviewed startup configuration. It never comes from ACP or a station.
type Runtime struct {
	Node, CLI, Manifest, State, Workspace, NodeID string
	// LauncherRoot and UnitPrefix name a separately provisioned launcher; empty keeps
	// /etc/salaam/stations and salaam-host.
	LauncherRoot, UnitPrefix string
	run                      func(context.Context, string, []string) ([]byte, error)
}
type strictWorkVersion struct {
	Version int `json:"version"`
}
type startupReceipt struct {
	StrictWork     *strictWorkVersion `json:"strict_work"`
	Version        int                `json:"version"`
	Ready          bool               `json:"ready"`
	ManifestDigest string             `json:"manifest_digest"`
	PinsDigest     string             `json:"pins_digest"`
	Node           string             `json:"node"`
	CLI            string             `json:"cli"`
	State          string             `json:"state"`
	Workspace      string             `json:"workspace"`
	NodeID         string             `json:"node_id"`
}
type boundedOutput struct{ bytes.Buffer }

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 65536 {
		return 0, fmt.Errorf("Salaam startup output exceeds limit")
	}
	return b.Buffer.Write(p)
}
func (r *Runtime) Ensure(ctx context.Context) error { return r.ensure(ctx, false) }

// ensureStrict requires the reviewed host manifest and actual startup health to
// agree on opt-in. The pinned host CLI owns full manifest validation.
func (r *Runtime) ensureStrict(ctx context.Context) error { return r.ensure(ctx, true) }
func (r *Runtime) ensure(ctx context.Context, requireStrict bool) error {
	if err := r.validatePaths(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	run := r.run
	if run == nil {
		run = func(ctx context.Context, node string, args []string) ([]byte, error) {
			cmd := exec.CommandContext(ctx, node, args...)
			cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + os.Getenv("HOME"), "LANG=en_US.UTF-8"}
			var out boundedOutput
			cmd.Stdout = &out
			// Private startup details stay in the daemon's log, outside gateway responses.
			if err := cmd.Run(); err != nil {
				return nil, fmt.Errorf("salaam: reviewed daemon startup failed; inspect private host logs")
			}
			return out.Bytes(), nil
		}
	}
	args := []string{r.CLI, "host", "start", "--manifest", r.Manifest}
	if unit := r.launcherUnit(); unit != "" {
		// Launcher profile: root owns the manifest and the host. The node only asks systemd
		// to start the provisioned unit and reads the receipt the running daemon reports.
		args = []string{r.CLI, "host", "unit-start", "--unit", unit, "--state", r.State}
	}
	data, err := run(ctx, r.Node, args)
	if err != nil {
		return err
	}
	var result startupReceipt
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	hash := regexp.MustCompile(`^[a-f0-9]{64}$`)
	if len(data) > 65536 || d.Decode(&result) != nil || d.Decode(new(any)) != io.EOF || result.Version != 1 || !result.Ready || result.Node != r.Node || result.CLI != r.CLI || result.State != r.State || result.Workspace != r.Workspace || result.NodeID != r.NodeID || !hash.MatchString(result.ManifestDigest) || !hash.MatchString(result.PinsDigest) {
		return fmt.Errorf("salaam: startup receipt differs from the configured node and private runtime")
	}
	if result.StrictWork != nil && result.StrictWork.Version != 1 {
		return fmt.Errorf("salaam: unsupported strict work startup version")
	}
	if requireStrict && result.StrictWork == nil {
		return fmt.Errorf("salaam: reviewed strict work opt-in required")
	}
	return nil
}

func (r *Runtime) validatePaths() error {
	for _, path := range []string{r.Node, r.CLI, r.Manifest} {
		if !filepath.IsAbs(path) {
			return fmt.Errorf("salaam: runtime, CLI and manifest paths must be absolute")
		}
		actual, err := filepath.EvalSymlinks(path)
		if err != nil || actual != path {
			return fmt.Errorf("salaam: runtime paths must be canonical")
		}
		st, err := os.Stat(path)
		if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0022 != 0 {
			return fmt.Errorf("salaam: runtime files must not be writable by other users")
		}
	}
	if !filepath.IsAbs(r.State) || !filepath.IsAbs(r.Workspace) || r.NodeID == "" {
		return fmt.Errorf("salaam: private state, workspace and enrolled node are required")
	}
	return nil
}

// launcherRoot holds root-provisioned launcher-profile manifests, one directory per station.
var launcherRoot = "/etc/salaam/stations"

// launcherUnit names the root-owned salaam-host@ unit when the configured manifest is the
// provisioned one for this workspace's station; otherwise the node starts the host itself.
func (r *Runtime) launcherUnit() string {
	root, prefix := launcherRoot, "salaam-host"
	if r.LauncherRoot != "" {
		root = r.LauncherRoot
	}
	if r.UnitPrefix != "" {
		prefix = r.UnitPrefix
	}
	if !LauncherPrefix.MatchString(prefix) {
		return ""
	}
	dir := filepath.Dir(r.Manifest)
	key := StationKey(r.Workspace)[len("salaam:"):]
	if filepath.Base(r.Manifest) != "host.json" || filepath.Dir(dir) != root || filepath.Base(dir) != key {
		return ""
	}
	return prefix + "@" + key + ".service"
}

// LauncherPrefix is salaam-host, or one lower-case word between salaam- and -host for a second
// launcher (Salaam host-bind launcherPrefix); anything else names no unit.
var LauncherPrefix = regexp.MustCompile(`^salaam(-[a-z][a-z0-9]{0,15})?-host$`)

// Validate checks configured installation paths without starting a process.
func (r *Runtime) Validate() error { return r.validatePaths() }
