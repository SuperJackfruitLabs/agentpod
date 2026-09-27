package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/pierrors"
)

// piErrorsVersion probes the Pi this node would run; tests replace it.
var piErrorsVersion = descriptor.PiVersion

// apn pi-errors installs the agentpod-errors Pi extension, which reports why a
// Pi turn failed to this node (pi-acp drops it over ACP). One file in Pi's
// global extensions directory; nothing to restart — each Pi session pi-acp
// starts loads it.
func piErrorsCmd(args []string, out, errOut io.Writer) int {
	if maybeShowHelp(out, "pi-errors", args) {
		return 0
	}
	usage := "usage: apn pi-errors <status|enable|disable> [--apply]"
	if len(args) == 0 {
		fmt.Fprintln(errOut, usage)
		return 2
	}
	action, apply := args[0], false
	for _, a := range args[1:] {
		if a != "--apply" {
			fmt.Fprintf(errOut, "unknown argument: %q\n%s\n", a, usage)
			return 2
		}
		apply = true
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(errOut, "cannot resolve the home directory:", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	min, max := pierrors.TestedRange()
	gate := func() (descriptor.VersionProbe, pierrors.Gate) {
		probe := piErrorsVersion(ctx)
		return probe, pierrors.CheckPi(probe.Status, probe.Version, probe.Reason)
	}
	gateLine := func(probe descriptor.VersionProbe, g pierrors.Gate) string {
		version := probe.Version
		if version == "" {
			version = probe.Status
		}
		verdict := "untested here, install refused"
		if g.Allowed {
			verdict = "tested"
		}
		return fmt.Sprintf("%s — %s: %s", version, verdict, g.Reason)
	}

	switch action {
	case "status":
		probe, g := gate()
		st := pierrors.Observe(home)
		fmt.Fprintln(out, pierrors.Name)
		fmt.Fprintf(out, "  shipped with this apn (tested on Pi %s to %s)\n", min, max)
		fmt.Fprintf(out, "  pi:       %s\n", gateLine(probe, g))
		switch {
		case st.Installed && st.Current:
			fmt.Fprintf(out, "  file:     installed by apn at %s\n", pierrors.Target(home))
		case st.Installed:
			fmt.Fprintf(out, "  file:     present at %s, different from this apn's copy; `enable` replaces it\n", pierrors.Target(home))
		default:
			fmt.Fprintln(out, "  file:     not installed")
		}
		if st.IntakeListening {
			fmt.Fprintf(out, "  node intake: listening at %s\n", st.IntakePath)
		} else {
			fmt.Fprintf(out, "  node intake: not listening at %s — reports would go nowhere\n", st.IntakePath)
		}
		return 0

	case "enable", "disable":
		var plan pierrors.Plan
		if action == "enable" {
			probe, g := gate()
			fmt.Fprintf(out, "pi: %s\n", gateLine(probe, g))
			if plan, err = pierrors.PlanEnable(home, g); err != nil {
				fmt.Fprintln(errOut, err)
				return 1
			}
		} else {
			plan = pierrors.PlanDisable(home)
		}
		switch plan.Action {
		case "keep":
			fmt.Fprintf(out, "nothing to do; %s is already %sd\n", pierrors.Name, action)
			return 0
		case "add":
			fmt.Fprintf(out, "enable would install %s\n", plan.Target)
		case "replace":
			fmt.Fprintf(out, "enable would replace %s with this apn's copy\n", plan.Target)
		case "remove":
			fmt.Fprintf(out, "disable would remove %s\n", plan.Target)
		}
		if !apply {
			fmt.Fprintln(out, "\nrerun with --apply to do this")
			return 0
		}
		if err := pierrors.Apply(plan); err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		fmt.Fprintf(out, "\n%sd %s. Each new Pi session loads what is there; nothing needs restarting.\n", action, pierrors.Name)
		return 0

	default:
		fmt.Fprintf(errOut, "unknown pi-errors action: %q\n%s\n", action, usage)
		return 2
	}
}
