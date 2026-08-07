package main

import ("context"; "errors"; "flag"; "fmt"; "os"; "runtime"
  "github.com/rakeshgangwar/agentpod/node-agent/internal/config"
  "github.com/rakeshgangwar/agentpod/node-agent/internal/enroll"
  "github.com/rakeshgangwar/agentpod/node-agent/internal/host"
  "github.com/rakeshgangwar/agentpod/node-agent/internal/selfupdate")

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
  if len(os.Args) < 2 { fmt.Println("usage: agentpod-node <enroll|run|detect|update|version>"); os.Exit(2) }
  switch os.Args[1] {
  case "enroll":
    fs := flag.NewFlagSet("enroll", flag.ExitOnError)
    flagHub := fs.String("hub", "", "hub base URL")
    flagToken := fs.String("token", "", "enrollment token")
    flagForce := fs.Bool("force", false, "re-enroll even when a valid config exists")
    fs.Parse(os.Args[2:])
    existing, loadErr := config.Load(config.DefaultPath())
    haveConfig := alreadyEnrolled(existing, loadErr)
    hub, token, err := resolveEnrollArgs(*flagHub, *flagToken, os.Getenv)
    if err != nil {
      // Bare `enroll` on an already-enrolled machine stays a friendly no-op.
      if haveConfig { fmt.Println("already enrolled:", existing.NodeID); return }
      fmt.Fprintln(os.Stderr, err); os.Exit(1)
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
    if haveConfig { fmt.Printf("re-enrolling: %s\n", reason) }
    id, sec, err := enroll.Enroll(hub, token, host.Info())
    if err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
    // Preserve operator-set lifecycle commands across re-enrollment.
    newCfg := config.Config{Hub: hub, NodeID: id, NodeSecret: sec,
      HermesStartCmd: existing.HermesStartCmd, OpenClawStartCmd: existing.OpenClawStartCmd}
    if err := config.Save(config.DefaultPath(), newCfg); err != nil {
      fmt.Fprintln(os.Stderr, err); os.Exit(1)
    }
    fmt.Println("enrolled:", id)
  case "run":
    runCmd() // implemented in Task 9
  case "detect":
    detectCmd() // debug/ops: print detected stations as JSON
  case "update":
    fs := flag.NewFlagSet("update", flag.ExitOnError)
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
        fmt.Fprintln(os.Stderr, "restart the service manually: systemctl restart agentpod-node")
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
    fmt.Printf("agentpod-node %s %s/%s\n", version, runtime.GOOS, runtime.GOARCH)
  default:
    fmt.Println("unknown command:", os.Args[1]); os.Exit(2)
  }
}
