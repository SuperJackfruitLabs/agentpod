package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/openclawerrors"
)

// openclawErrorsVersion probes the OpenClaw this node would run; tests replace it.
var openclawErrorsVersion = descriptor.OpenClawVersion

// openclawErrorsNow is the clock an apply records; tests replace it.
var openclawErrorsNow = time.Now

// apn openclaw-errors installs the agentpod-errors plugin, which reports why an
// OpenClaw turn failed to this node (OpenClaw's ACP bridge drops the words).
// Like hermes-live: it shows exactly what it would change, writes nothing
// without --apply, and never restarts the gateway — one OpenClaw gateway
// serves every agent on the machine, so when to restart it is the operator's.
func openclawErrorsCmd(args []string, out, errOut io.Writer) int {
	if maybeShowHelp(out, "openclaw-errors", args) {
		return 0
	}
	usage := "usage: apn openclaw-errors <status|enable|disable> [--apply]"
	if len(args) == 0 {
		fmt.Fprintln(errOut, usage)
		return 2
	}
	action, apply := args[0], false
	for _, a := range args[1:] {
		switch a {
		case "--apply":
			apply = true
		default:
			fmt.Fprintf(errOut, "unknown argument: %q\n", a)
			fmt.Fprintln(errOut, usage)
			return 2
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(errOut, "cannot resolve the home directory:", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	min, max := openclawerrors.TestedRange()

	gateLine := func(probe descriptor.VersionProbe, gate openclawerrors.Gate) string {
		version := probe.Version
		if version == "" {
			version = probe.Status
		}
		verdict := "untested here, install refused"
		if gate.Allowed {
			verdict = "tested"
		}
		return fmt.Sprintf("%s — %s: %s", version, verdict, gate.Reason)
	}

	switch action {
	case "status":
		probe := openclawErrorsVersion(ctx)
		gate := openclawerrors.CheckOpenClaw(probe.Status, probe.Version, probe.Reason)
		st := openclawerrors.Observe(home)
		fmt.Fprintf(out, "%s\n", openclawerrors.Name)
		fmt.Fprintf(out, "  shipped with this apn: %s (tested on OpenClaw %s to %s)\n", openclawerrors.Version(), min, max)
		fmt.Fprintf(out, "  openclaw: %s\n", gateLine(probe, gate))
		switch {
		case st.Installed && st.Current:
			fmt.Fprintf(out, "  files:    installed by apn, %s\n", openclawerrors.Version())
		case st.Installed:
			fmt.Fprintf(out, "  files:    present at %s, different from this apn's copy; `enable` replaces them\n", openclawerrors.PluginDir(home))
		default:
			fmt.Fprintln(out, "  files:    not installed")
		}
		switch {
		case st.ConfigError != "":
			fmt.Fprintf(out, "  enabled:  unknown — %s\n", st.ConfigError)
		case st.Enabled && st.ConversationAccess:
			fmt.Fprintln(out, "  enabled:  yes, with hooks.allowConversationAccess")
		case st.Enabled:
			fmt.Fprintln(out, "  enabled:  yes, but without hooks.allowConversationAccess — OpenClaw blocks its agent_end hook; run enable again")
		default:
			fmt.Fprintln(out, "  enabled:  no")
		}
		if st.IntakeListening {
			fmt.Fprintf(out, "  node intake: listening at %s\n", st.IntakePath)
		} else {
			fmt.Fprintf(out, "  node intake: not listening at %s — this node's agentpod-node predates it, or is not running; reports would go nowhere\n", st.IntakePath)
		}
		fmt.Fprintln(out, "  (configured state; the running gateway loaded what was configured when it started.\n"+
			"   `openclaw plugins inspect agentpod-errors --runtime --json` asks the gateway itself.)")
		return 0

	case "enable", "disable":
		var plan openclawerrors.Plan
		if action == "enable" {
			probe := openclawErrorsVersion(ctx)
			gate := openclawerrors.CheckOpenClaw(probe.Status, probe.Version, probe.Reason)
			fmt.Fprintf(out, "openclaw: %s\n", gateLine(probe, gate))
			plan, err = openclawerrors.PlanEnable(home, gate)
		} else {
			plan, err = openclawerrors.PlanDisable(home)
		}
		if err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		if plan.NoOp {
			fmt.Fprintf(out, "nothing to do; %s is already %sd\n", openclawerrors.Name, action)
			return 0
		}
		switch plan.FileAction {
		case "add":
			fmt.Fprintf(out, "%s would install %s %s at %s:\n", action, openclawerrors.Name, openclawerrors.Version(), plan.PluginDir)
			for _, name := range openclawerrors.FileNames() {
				fmt.Fprintf(out, "  + %s\n", name)
			}
		case "replace":
			fmt.Fprintf(out, "%s would replace the files at %s with %s %s\n", action, plan.PluginDir, openclawerrors.Name, openclawerrors.Version())
		case "remove":
			fmt.Fprintf(out, "%s would remove %s\n", action, plan.PluginDir)
		}
		if string(plan.ConfigBefore) == string(plan.ConfigAfter) {
			fmt.Fprintf(out, "%s is unchanged\n", plan.ConfigPath)
		} else {
			fmt.Fprintf(out, "%s would change:\n\n", plan.ConfigPath)
			fmt.Fprint(out, openclawerrors.Diff(string(plan.ConfigBefore), string(plan.ConfigAfter)))
			fmt.Fprintln(out, "\nthe current file is backed up beside it first")
		}
		if !apply {
			fmt.Fprintln(out, "\nrerun with --apply to do this")
			return 0
		}
		if err := openclawerrors.Apply(plan, openclawErrorsNow()); err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		effect := "load"
		if action == "disable" {
			effect = "unload"
		}
		fmt.Fprintf(out, "\n%sd %s\n", action, openclawerrors.Name)
		fmt.Fprintf(out, "The OpenClaw gateway reads plugins at start. Nothing was restarted; to %s the plugin,\n"+
			"restart it when no agent is mid-turn, for example: systemctl --user restart openclaw-gateway.service\n"+
			"Then `apn openclaw-errors status` shows what is configured.\n", effect)
		return 0

	default:
		fmt.Fprintf(errOut, "unknown openclaw-errors action: %q\n", action)
		fmt.Fprintln(errOut, usage)
		return 2
	}
}
