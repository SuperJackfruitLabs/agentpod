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
	run                                           func(context.Context, string, []string) ([]byte, error)
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
	data, err := run(ctx, r.Node, []string{r.CLI, "host", "start", "--manifest", r.Manifest})
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
