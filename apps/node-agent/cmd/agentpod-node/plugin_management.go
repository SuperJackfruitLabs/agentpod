package main

import (
	"fmt"
	"io"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

// setPluginManagement changes only the gate that lets the Console install and
// remove the agentpod-live plugin, and preserves everything else, as
// setNativeSkillActivation does for its own gate.
func setPluginManagement(path string, enabled bool) (changed bool, err error) {
	cfg, err := config.Load(path)
	if err != nil {
		return false, fmt.Errorf("not enrolled; run `agentpod-node enroll` first: %w", err)
	}
	if cfg.PluginManagement == enabled {
		return false, nil
	}
	cfg.PluginManagement = enabled
	if err := config.Save(path, cfg); err != nil {
		return false, err
	}
	return true, nil
}

func pluginManagementCmd(args []string, out, errOut io.Writer) int {
	if maybeShowHelp(out, "plugin-management", args) {
		return 0
	}
	usage := "usage: apn plugin-management <status|enable|disable>"
	if len(args) != 1 {
		fmt.Fprintln(errOut, usage)
		return 2
	}
	path := config.DefaultPath()
	switch args[0] {
	case "status":
		cfg, err := config.Load(path)
		if err != nil {
			fmt.Fprintln(errOut, "not enrolled; run `agentpod-node enroll` first:", err)
			return 1
		}
		if cfg.PluginManagement {
			fmt.Fprintln(out, "console plugin management: enabled")
		} else {
			fmt.Fprintln(out, "console plugin management: disabled")
		}
		return 0
	case "enable", "disable":
		enabled := args[0] == "enable"
		changed, err := setPluginManagement(path, enabled)
		if err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		state := "enabled"
		if !enabled {
			state = "disabled"
		}
		if changed {
			fmt.Fprintf(out, "console plugin management: %s; restart the node service to apply it\n", state)
		} else {
			fmt.Fprintf(out, "console plugin management is already %s\n", state)
		}
		return 0
	default:
		fmt.Fprintf(errOut, "unknown plugin-management action: %q\n", args[0])
		fmt.Fprintln(errOut, usage)
		return 2
	}
}
