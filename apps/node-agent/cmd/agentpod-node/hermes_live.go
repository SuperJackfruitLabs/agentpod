package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// hermesLiveVersion probes the Hermes this node would run; tests replace it.
var hermesLiveVersion = descriptor.HermesVersion

// hermesLiveNow is the clock an apply records; tests replace it.
var hermesLiveNow = time.Now

// Installing the agentpod-live plugin into a Hermes profile is an operator
// action on the host, like `hermes-skills register` (#553): it writes a
// directory Hermes discovers and edits the profile's configuration. The
// command shows exactly what it would do and writes nothing without --apply.
// It never restarts a gateway; loading the plugin needs one, and that stays
// the operator's decision.
func hermesLiveCmd(args []string, out, errOut io.Writer) int {
	if maybeShowHelp(out, "hermes-live", args) {
		return 0
	}
	usage := "usage: apn hermes-live <status|enable|disable> --profile NAME [--apply] [--replace-unmanaged]"
	if len(args) == 0 {
		fmt.Fprintln(errOut, usage)
		return 2
	}
	action := args[0]
	profile, apply, replace := "", false, false
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "--profile":
			if i+1 >= len(args) {
				fmt.Fprintln(errOut, "--profile needs a profile name")
				return 2
			}
			i++
			profile = args[i]
		case "--apply":
			apply = true
		case "--replace-unmanaged":
			replace = true
		default:
			fmt.Fprintf(errOut, "unknown argument: %q\n", args[i])
			fmt.Fprintln(errOut, usage)
			return 2
		}
	}
	if profile == "" || strings.ContainsAny(profile, "/\\ ") || profile == "." || profile == ".." {
		fmt.Fprintln(errOut, "--profile must name one Hermes profile")
		return 2
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(errOut, "cannot resolve the home directory:", err)
		return 1
	}
	dir := filepath.Join(home, ".hermes", "profiles", profile)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		fmt.Fprintf(errOut, "no Hermes profile at %s\n", dir)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	unit := "hermes-gateway-" + profile + ".service"

	switch action {
	case "status":
		probe := hermesLiveVersion(ctx)
		gate := hermeslive.CheckHermes(probe.Status, probe.Version, probe.Reason)
		_, st := hermeslive.Observe(dir, hermesLiveNow())
		fmt.Fprintf(out, "%s in profile %s\n", hermeslive.Name, profile)
		fmt.Fprintf(out, "  shipped with this apn: %s (tested on Hermes %s to %s)\n", hermeslive.EmbeddedManifest().Version,
			strings.TrimPrefix(hermeslive.EmbeddedManifest().RequiresHermes, ">="), hermeslive.TestedMax())
		fmt.Fprintf(out, "  hermes:   %s\n", gateLine(probe, gate))
		fmt.Fprintf(out, "  files:    %s\n", filesLine(st))
		fmt.Fprintf(out, "  enabled:  %s\n", observationLine(st.Enabled))
		fmt.Fprintf(out, "  loaded:   %s\n", observationLine(st.Loaded))
		fmt.Fprintf(out, "  last turn: %s\n", observationLine(st.LastTurn))
		return 0

	case "enable", "disable":
		var plan hermeslive.Plan
		if action == "enable" {
			probe := hermesLiveVersion(ctx)
			gate := hermeslive.CheckHermes(probe.Status, probe.Version, probe.Reason)
			fmt.Fprintf(out, "hermes: %s\n", gateLine(probe, gate))
			plan, err = hermeslive.PlanEnable(dir, gate, replace)
		} else {
			plan, err = hermeslive.PlanDisable(dir)
		}
		if err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		if plan.NoOp {
			fmt.Fprintf(out, "%s: nothing to do; %s %s is installed and enabled\n", profile, hermeslive.Name, hermeslive.EmbeddedManifest().Version)
			return 0
		}
		printPlan(out, plan)
		if !apply {
			fmt.Fprintln(out, "\nrerun with --apply to do this")
			return 0
		}
		if err := hermeslive.Apply(plan, hermesLiveNow()); err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		fmt.Fprintf(out, "\n%s: %sd %s\n", profile, action, hermeslive.Name)
		effect := "load"
		if action == "disable" {
			effect = "unload"
		}
		fmt.Fprintf(out, "The gateway reads plugins and configuration at start. Nothing was restarted; to %s the plugin,\n"+
			"restart the station from the Console, or run: systemctl --user restart %s\n"+
			"Then `apn hermes-live status --profile %s` shows what the gateway has.\n", effect, unit, profile)
		return 0

	default:
		fmt.Fprintf(errOut, "unknown hermes-live action: %q\n", action)
		fmt.Fprintln(errOut, usage)
		return 2
	}
}

func printPlan(out io.Writer, plan hermeslive.Plan) {
	target := filepath.Join(plan.ProfileDir, "plugins", hermeslive.Name)
	switch plan.FileAction {
	case "add":
		fmt.Fprintf(out, "%s would install %s %s at %s:\n", plan.Action, hermeslive.Name, hermeslive.EmbeddedManifest().Version, target)
		for _, name := range hermeslive.FileNames() {
			fmt.Fprintf(out, "  + %s\n", name)
		}
	case "replace":
		fmt.Fprintf(out, "%s would replace %s with %s %s\n", plan.Action, target, hermeslive.Name, hermeslive.EmbeddedManifest().Version)
	case "adopt":
		fmt.Fprintf(out, "%s would adopt the copy at %s as apn-managed (its files are unchanged)\n", plan.Action, target)
	case "remove":
		fmt.Fprintf(out, "%s would remove %s\n", plan.Action, target)
	case "keep":
		fmt.Fprintf(out, "%s leaves %s as it is\n", plan.Action, target)
	}
	for _, note := range plan.Notes {
		fmt.Fprintf(out, "  note: %s\n", note)
	}
	config := filepath.Join(plan.ProfileDir, "config.yaml")
	switch {
	case string(plan.ConfigAfter) == string(plan.ConfigBefore):
		fmt.Fprintf(out, "%s is unchanged\n", config)
	case plan.RestoresBackup:
		fmt.Fprintf(out, "%s is restored from the backup taken at enable:\n\n", config)
		fmt.Fprint(out, diffLines(string(plan.ConfigBefore), string(plan.ConfigAfter)))
	default:
		fmt.Fprintf(out, "%s would change:\n\n", config)
		fmt.Fprint(out, diffLines(string(plan.ConfigBefore), string(plan.ConfigAfter)))
		if plan.Action == "enable" {
			fmt.Fprintln(out, "\nthe current file is backed up beside it first")
		}
	}
}

func gateLine(probe descriptor.VersionProbe, gate hermeslive.Gate) string {
	version := probe.Version
	if version == "" {
		version = probe.Status
	}
	// Only a known version outside the range is "untested"; an undetermined or
	// missing Hermes is said as such, never as a version verdict.
	verdict := "untested here, install refused"
	switch {
	case gate.Allowed:
		verdict = "tested"
	case probe.Status == descriptor.VersionUndetermined:
		verdict = "version undetermined, install held"
	case probe.Status == descriptor.VersionAbsent:
		verdict = "not installed"
	}
	return fmt.Sprintf("%s — %s: %s", version, verdict, gate.Reason)
}

func filesLine(st hermeslive.Status) string {
	switch {
	case !st.Present:
		return "not installed"
	case st.Managed && st.Current:
		return "installed by apn, " + st.Version
	case st.Managed:
		return "installed by apn, " + st.Version + " (this apn ships " + hermeslive.EmbeddedManifest().Version + ")"
	case st.Current:
		return "installed by hand, identical to this apn's " + st.Version + "; `enable` adopts it"
	default:
		return "installed by hand and different from this apn's copy; `enable --replace-unmanaged` sets it aside"
	}
}

func observationLine(o skills.Observation) string {
	switch {
	case o.Value == nil:
		return "unknown — " + o.Reason
	case *o.Value:
		return "yes — " + o.Reason
	default:
		return "no — " + o.Reason
	}
}
