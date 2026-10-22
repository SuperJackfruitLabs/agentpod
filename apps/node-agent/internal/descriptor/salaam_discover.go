package descriptor

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// DiscoverSalaam fills the Salaam fields the node config leaves empty from a
// per-user install under home, so a fresh node finds Salaam without hand-edited
// config. An explicit field always wins. Nothing is filled unless a Salaam
// binary is present.
//
//   - binary: `salaam` on PATH, else ~/.local/bin/salaam
//   - state: ~/.local/state/salaam, when its operator.sock exists
//   - workspace: the workspace Salaam's AgentPod pins name
//     (~/.config/salaam/agentpod-pins.json), else ~/work when it exists
func DiscoverSalaam(c SalaamConfig, home string, lookPath func(string) (string, error)) SalaamConfig {
	if home == "" || c.Manifest != "" {
		return c
	}
	if c.Binary == "" {
		if p, err := lookPath("salaam"); err == nil && filepath.IsAbs(p) {
			c.Binary = p
		} else if fi, err := os.Stat(filepath.Join(home, ".local", "bin", "salaam")); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			c.Binary = filepath.Join(home, ".local", "bin", "salaam")
		} else {
			return c
		}
	}
	if c.StateDir == "" {
		state := filepath.Join(home, ".local", "state", "salaam")
		if _, err := os.Stat(filepath.Join(state, "operator.sock")); err == nil {
			c.StateDir = state
		}
	}
	if c.Workspace == "" {
		candidate := pinnedWorkspace(filepath.Join(home, ".config", "salaam", "agentpod-pins.json"))
		if candidate == "" {
			candidate = filepath.Join(home, "work")
		}
		if fi, err := os.Stat(candidate); err == nil && fi.IsDir() {
			if canonical, err := filepath.EvalSymlinks(candidate); err == nil {
				c.Workspace = canonical
			}
		}
	}
	return c
}

// pinnedWorkspace reads only the workspace from Salaam's AgentPod pins file.
func pinnedWorkspace(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	var pins struct {
		Workspace string `json:"workspace"`
	}
	if json.NewDecoder(io.LimitReader(f, 16384)).Decode(&pins) != nil || !filepath.IsAbs(pins.Workspace) {
		return ""
	}
	return pins.Workspace
}
