package descriptor

import (
	"context"
	"fmt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type SalaamConfig struct{ Binary, StateDir, Workspace string }
type salaamDescriptor struct{ config SalaamConfig }

func NewSalaamFrom(c SalaamConfig) Descriptor { return &salaamDescriptor{c} }
func (s *salaamDescriptor) Harness() string   { return "salaam" }
func (s *salaamDescriptor) configured() bool {
	return s.config.Binary != "" && filepath.IsAbs(s.config.StateDir) && filepath.IsAbs(s.config.Workspace)
}
func (s *salaamDescriptor) Detect() ([]Station, error) {
	if !s.configured() {
		return nil, nil
	}
	if _, err := exec.LookPath(s.config.Binary); err != nil {
		return nil, nil
	}
	if _, err := os.Stat(filepath.Join(s.config.StateDir, "operator.sock")); err != nil {
		return nil, nil
	}
	workspace, err := filepath.EvalSymlinks(s.config.Workspace)
	if err != nil || workspace != s.config.Workspace {
		return nil, fmt.Errorf("salaam: workspace must be a canonical directory")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !(&salaam.Client{State: s.config.StateDir}).Healthy(ctx) {
		return nil, nil
	}
	return []Station{{Key: salaam.StationKey(workspace), Harness: "salaam", Kind: "leaf", DisplayName: "Salaam", WorkspacePath: &workspace, Capabilities: []string{"inventory", "health", "acp"}}}, nil
}
func (s *salaamDescriptor) Health(key string) (Health, error) {
	if key != salaam.StationKey(s.config.Workspace) || !s.configured() {
		return Health{}, fmt.Errorf("salaam: unknown station")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	note := "Daemon health observed; execution still requires a fresh bound authority lease"
	return Health{Running: (&salaam.Client{State: s.config.StateDir}).Healthy(ctx), Note: &note}, nil
}
func (s *salaamDescriptor) ACPCommand(key string) ([]string, string, []string, error) {
	if key != salaam.StationKey(s.config.Workspace) || !s.configured() {
		return nil, "", nil, fmt.Errorf("salaam: unknown station")
	}
	return []string{s.config.Binary, "acp", "--state", s.config.StateDir}, s.config.Workspace, nil, nil
}
func (s *salaamDescriptor) ListDir(string, string) ([]FsEntry, error) {
	return nil, fmt.Errorf("salaam: station filesystem access is not enabled")
}
func (s *salaamDescriptor) ReadFile(string, string, int64) ([]byte, string, bool, error) {
	return nil, "", false, fmt.Errorf("salaam: station filesystem access is not enabled")
}
func (s *salaamDescriptor) TailLogs(context.Context, string, bool, func([]byte) error) error {
	return fmt.Errorf("salaam: logs are not exposed as station files")
}
