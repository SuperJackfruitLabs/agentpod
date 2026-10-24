package descriptor

import (
	"context"
	"fmt"
	"log"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type SalaamConfig struct{ Binary, StateDir, Workspace, NodeBinary, Manifest, NodeID string }
type salaamDescriptor struct {
	config    SalaamConfig
	configure func(context.Context, string, any) ([]byte, error)
	mu        sync.Mutex
	lastMiss  string
	logf      func(string, ...any)
}

// miss logs why a configured Salaam was not detected, once per distinct reason,
// so a silent zero-station inventory can be diagnosed from the node's journal.
func (s *salaamDescriptor) miss(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if reason == s.lastMiss {
		return
	}
	s.lastMiss = reason
	if reason == "" {
		return
	}
	logf := s.logf
	if logf == nil {
		logf = log.Printf
	}
	logf("salaam: station not detected: %s", reason)
}

func NewSalaamFrom(c SalaamConfig) Descriptor { return &salaamDescriptor{config: c} }
func (s *salaamDescriptor) Harness() string   { return "salaam" }
func (s *salaamDescriptor) configured() bool {
	return filepath.IsAbs(s.config.Binary) && filepath.IsAbs(s.config.StateDir) && filepath.IsAbs(s.config.Workspace)
}
func (s *salaamDescriptor) client() *salaam.Client {
	c := &salaam.Client{State: s.config.StateDir, Workspace: s.config.Workspace, NodeID: s.config.NodeID}
	if s.config.Manifest != "" || s.config.NodeBinary != "" {
		c.Runtime = &salaam.Runtime{Node: s.config.NodeBinary, CLI: s.config.Binary, Manifest: s.config.Manifest, State: s.config.StateDir, Workspace: s.config.Workspace, NodeID: s.config.NodeID}
	}
	return c
}
func (s *salaamDescriptor) Detect() ([]Station, error) {
	if !s.configured() {
		return nil, nil
	}
	if _, err := exec.LookPath(s.config.Binary); err != nil {
		s.miss("binary not executable: " + err.Error())
		return nil, nil
	}
	if s.config.Manifest == "" {
		if _, err := os.Stat(filepath.Join(s.config.StateDir, "operator.sock")); err != nil {
			s.miss("no operator socket: " + err.Error())
			return nil, nil
		}
	}
	workspace, err := filepath.EvalSymlinks(s.config.Workspace)
	if err != nil || workspace != s.config.Workspace {
		s.miss("workspace is not a canonical directory: " + s.config.Workspace)
		return nil, fmt.Errorf("salaam: workspace must be a canonical directory")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	if s.config.Manifest != "" {
		if err := s.client().Runtime.Validate(); err != nil {
			return nil, err
		}
	} else {
		if health := s.client().ObserveHealth(ctx); !health.Running {
			s.miss(health.Reason)
			return nil, nil
		}
	}
	s.miss("")
	return []Station{{Key: salaam.StationKey(workspace), Harness: "salaam", Kind: "leaf", DisplayName: "Salaam", WorkspacePath: &workspace, Capabilities: AppendChangesetCap([]string{"inventory", "health", "logs", "fs.read", "acp", "skills.inventory"}, &workspace)}}, nil
}
func (s *salaamDescriptor) Health(key string) (Health, error) {
	if key != salaam.StationKey(s.config.Workspace) || !s.configured() {
		return Health{}, fmt.Errorf("salaam: unknown station")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	note := "Daemon health observed; execution still requires a fresh bound authority lease"
	health := s.client().ObserveHealth(ctx)
	out := Health{Running: health.Running, PID: health.PID, ConfigurationDigest: health.ConfigurationDigest, Note: &note}
	if health.PID != nil {
		out.CpuPct, out.MemBytes, out.UptimeSec = gatherPidMetrics(*health.PID)
	}
	out.DiskBytes = salaamWorkspaceDisk(s.config.Workspace)
	out.LastActivity = salaamLastActivity(health.LastActivityAt, s.config.StateDir)
	return out, nil
}
func (s *salaamDescriptor) ACPCommand(key string) ([]string, string, []string, error) {
	if key != salaam.StationKey(s.config.Workspace) || !s.configured() {
		return nil, "", nil, fmt.Errorf("salaam: unknown station")
	}
	command := []string{s.config.Binary, "acp", "--state", s.config.StateDir}
	if s.config.Manifest != "" || s.config.NodeBinary != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		if err := s.client().Runtime.Ensure(ctx); err != nil {
			return nil, "", nil, err
		}
		command = append([]string{s.config.NodeBinary}, command...)
	}
	return command, s.config.Workspace, nil, nil
}
