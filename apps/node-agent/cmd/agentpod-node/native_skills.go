package main

import (
	"fmt"
	"io"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

// setNativeSkillActivation changes only the explicit native placement gate and
// preserves node identity plus all runtime configuration. Keeping this small
// operation separate from enrollment makes activation auditable and reversible.
func setNativeSkillActivation(path string, enabled bool) (changed bool, err error) {
	cfg, err := config.Load(path)
	if err != nil {
		return false, fmt.Errorf("not enrolled; run `agentpod-node enroll` first: %w", err)
	}
	if cfg.NativeSkillActivation == enabled {
		return false, nil
	}
	cfg.NativeSkillActivation = enabled
	if err := config.Save(path, cfg); err != nil {
		return false, err
	}
	return true, nil
}

func nativeSkillsCmd(args []string, out, errOut io.Writer) int {
	if maybeShowHelp(out, "native-skills", args) {
		return 0
	}
	if len(args) != 1 {
		fmt.Fprintln(errOut, "usage: apn native-skills <status|enable|disable>")
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
		if cfg.NativeSkillActivation {
			fmt.Fprintln(out, "native skill placement: enabled")
		} else {
			fmt.Fprintln(out, "native skill placement: disabled")
		}
		return 0
	case "enable", "disable":
		enabled := args[0] == "enable"
		changed, err := setNativeSkillActivation(path, enabled)
		if err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		state := "enabled"
		if !enabled {
			state = "disabled"
		}
		if changed {
			fmt.Fprintf(out, "native skill placement: %s; restart the node service to apply it\n", state)
		} else {
			fmt.Fprintf(out, "native skill placement is already %s\n", state)
		}
		return 0
	default:
		fmt.Fprintf(errOut, "unknown native-skills action: %q\n", args[0])
		fmt.Fprintln(errOut, "usage: apn native-skills <status|enable|disable>")
		return 2
	}
}
