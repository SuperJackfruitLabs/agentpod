package salaam

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// Configuration delegates the existing config.manage wire to the pinned Salaam
// CLI. In particular it never calls Ensure: observing or reviewing a document
// must not implicitly start a daemon. The host CLI owns validation and journal.
func (r *Runtime) Configuration(ctx context.Context, action string, request any) ([]byte, error) {
	switch action {
	case "observe", "plan", "apply", "inspect":
	default:
		return nil, fmt.Errorf("salaam: unsupported configuration action")
	}
	if err := r.validatePaths(); err != nil {
		return nil, err
	}
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if len(data) > 65536 {
		return nil, fmt.Errorf("salaam: configuration request exceeds limit")
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Node, r.CLI, "host", "config-"+action, "--manifest", r.Manifest)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + os.Getenv("HOME"), "LANG=en_US.UTF-8"}
	cmd.Stdin = bytes.NewReader(data)
	var out boundedOutput
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("salaam: native configuration command refused; inspect private host configuration")
	}
	return out.Bytes(), nil
}
