package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/enroll"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/host"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/selfupdate"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/service"
	"os"
	"runtime"
)

// version is the agent's build version. Overridden at link time via:
//
//	-ldflags "-X main.version=<tag>"
var version = "dev"

// alreadyEnrolled returns true when a previously saved config exists and
// contains both NodeID and NodeSecret, meaning the node has already been
// enrolled. This is used to make the enroll subcommand idempotent so that
// container restarts (which re-run the entrypoint) do not attempt to consume
// an already-spent one-time enrollment token.
func alreadyEnrolled(cfg config.Config, loadErr error) bool {
	return loadErr == nil && cfg.NodeID != "" && cfg.NodeSecret != ""
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println(helpText(version))
		os.Exit(0)
	}
	switch os.Args[1] {
	case "help", "-h", "--help":
		if os.Args[1] == "help" && len(os.Args) > 2 {
			name := os.Args[2]
			if !isCommand(name) {
				fmt.Printf("unknown command: %q\n", name)
				os.Exit(2)
			}
			fmt.Println(commandHelp(name))
			os.Exit(0)
		}
		fmt.Println(helpText(version))
		os.Exit(0)
	case "enroll":
		fs := flag.NewFlagSet("enroll", flag.ExitOnError)
		fs.Usage = func() {
			fmt.Fprintln(fs.Output(), commandHelp("enroll"))
			fs.PrintDefaults()
		}
		flagHub := fs.String("hub", "", "hub base URL")
		flagToken := fs.String("token", "", "enrollment token")
		flagForce := fs.Bool("force", false, "re-enroll even when a valid config exists")
		fs.Parse(os.Args[2:])
		existing, loadErr := config.Load(config.DefaultPath())
		haveConfig := alreadyEnrolled(existing, loadErr)
		hub, token, err := resolveEnrollArgs(*flagHub, *flagToken, os.Getenv)
		if err != nil {
			// Bare `enroll` on an already-enrolled machine stays a friendly no-op.
			if haveConfig {
				fmt.Println("already enrolled:", existing.NodeID)
				return
			}
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		decision, reason := decideEnroll(existing, haveConfig, hub, *flagForce, enroll.CheckCredential)
		switch decision {
		case decisionKeep:
			fmt.Printf("already enrolled: %s (%s)\n", existing.NodeID, reason)
			return
		case decisionKeepUnverified:
			// Keep a possibly-valid identity; `run` retries connecting anyway.
			fmt.Fprintf(os.Stderr, "warning: keeping existing config (%s)\n", reason)
			return
		}
		if haveConfig {
			fmt.Printf("re-enrolling: %s\n", reason)
		}
		id, sec, err := enroll.Enroll(hub, token, host.Info())
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		// Preserve operator-set lifecycle commands across re-enrollment.
		newCfg := config.Config{Hub: hub, NodeID: id, NodeSecret: sec,
			HermesStartCmd: existing.HermesStartCmd, OpenClawStartCmd: existing.OpenClawStartCmd}
		if err := config.Save(config.DefaultPath(), newCfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("enrolled:", id)
	case "run":
		if maybeShowHelp(os.Stdout, "run", os.Args[2:]) {
			os.Exit(0)
		}
		runCmd() // implemented in Task 9
	case "detect":
		if maybeShowHelp(os.Stdout, "detect", os.Args[2:]) {
			os.Exit(0)
		}
		detectCmd() // debug/ops: print detected stations as JSON
	case "scan":
		if maybeShowHelp(os.Stdout, "scan", os.Args[2:]) {
			os.Exit(0)
		}
		scanCmd(os.Args[2:]) // hubless posture check; exits non-zero on findings
	case "acp":
		if maybeShowHelp(os.Stdout, "acp", os.Args[2:]) {
			os.Exit(0)
		}
		acpCmd(os.Args[2:]) // Doors: pipe an editor's stdio to a hub station
	case "update":
		fs := flag.NewFlagSet("update", flag.ExitOnError)
		fs.Usage = func() {
			fmt.Fprintln(fs.Output(), commandHelp("update"))
			fs.PrintDefaults()
		}
		check := fs.Bool("check", false, "resolve and report current/latest version, no changes")
		force := fs.Bool("force", false, "update even when already on the latest version")
		fs.Parse(os.Args[2:])
		ctx := context.Background()
		res, err := selfupdate.Update(ctx, selfupdate.Options{
			CurrentVersion: version,
			Force:          *force,
			CheckOnly:      *check,
		})
		if err != nil {
			if errors.Is(err, selfupdate.ErrRestartFailed) {
				fmt.Fprintln(os.Stderr, "update: binary swapped but service restart failed:", err)
				if runtime.GOOS == "darwin" {
					fmt.Fprintf(os.Stderr, "restart it manually: launchctl kickstart -k gui/%d/dev.agentpod.node  (or re-run: apn run)\n", os.Getuid())
				} else {
					fmt.Fprintln(os.Stderr, "restart the service manually: systemctl restart agentpod-node")
				}
				os.Exit(1)
			}
			fmt.Fprintln(os.Stderr, "update:", err)
			os.Exit(1)
		}
		fmt.Printf("current %s, latest %s\n", res.CurrentVersion, res.LatestTag)
		switch {
		case res.Updated:
			fmt.Printf("updated to %s, restarting…\n", res.LatestTag)
		case *check:
			if res.CurrentVersion == res.LatestTag {
				fmt.Println("up to date")
			} else {
				fmt.Printf("update available: %s → %s\n", res.CurrentVersion, res.LatestTag)
			}
		default:
			fmt.Println(res.Reason)
		}
	case "version":
		if maybeShowHelp(os.Stdout, "version", os.Args[2:]) {
			os.Exit(0)
		}
		fmt.Printf("agentpod-node %s %s/%s\n", version, runtime.GOOS, runtime.GOARCH)
	case "stop":
		// stopEntry gates on -h/--help itself (see help.go's maybeShowHelp) —
		// NewManager has no side effects of its own (it only inspects
		// runtime.GOOS/uid), so it's safe to construct before that gate runs.
		mgr, err := service.NewManager(nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(stopEntry(mgr, os.Args[2:], os.Stdout))
	case "start":
		mgr, err := service.NewManager(nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(startEntry(mgr, os.Args[2:], os.Stdout))
	case "restart":
		mgr, err := service.NewManager(nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(restartEntry(mgr, os.Args[2:], os.Stdout))
	case "status":
		jsonOut, done, code := parseStatusFlags(os.Args[2:], os.Stdout)
		if done {
			os.Exit(code)
		}
		mgr, err := service.NewManager(nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		cfg, cfgErr := config.Load(config.DefaultPath())
		os.Exit(statusCmd(mgr, cfg, cfgErr, enroll.CheckCredential, jsonOut, os.Stdout))
	case "logs":
		mgr, err := service.NewManager(nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(logsCmd(mgr, os.Args[2:], os.Stdout, os.Stderr))
	case "service":
		mgr, err := service.NewManager(nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		var verb string
		var rest []string
		if len(os.Args) > 2 {
			verb = os.Args[2]
		}
		if len(os.Args) > 3 {
			rest = os.Args[3:]
		}
		os.Exit(runServiceVerb(verb, rest, mgr, os.Stdout))
	default:
		fmt.Printf("unknown command: %q\n", os.Args[1])
		if s := suggestCommand(os.Args[1]); s != "" {
			fmt.Printf("did you mean '%s'?\n", s)
		}
		fmt.Println("run 'apn help' for usage.")
		os.Exit(2)
	}
}
