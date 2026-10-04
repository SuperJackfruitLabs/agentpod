package main

import (
	"log"
	"os"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/otelenv"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/service"
)

// unitScope decides, from the daemon's cgroup (otelenv.DaemonPath), whether this process
// is the agentpod-node systemd service and in which scope. ok=false means "n/a": nothing
// to reconcile and nothing to touch.
func unitScope(daemonPath func() (string, error)) (userScope, ok bool) {
	path, err := daemonPath()
	if err != nil {
		return false, false
	}
	return path != otelenv.SystemPath, true
}

// daemonUnitReconciler binds the real reconcile to this node's home and config dir.
func daemonUnitReconciler() func(userScope, dryRun bool) service.ReconcileResult {
	home, _ := os.UserHomeDir()
	markerDir := filepath.Dir(config.DefaultPath())
	return func(userScope, dryRun bool) service.ReconcileResult {
		return service.ReconcileDaemonUnit(userScope, home, markerDir, dryRun)
	}
}

// daemonUnitChecker is the telemetry handler's unit hook.
func daemonUnitChecker() func(apply bool) (string, string) {
	reconcile := daemonUnitReconciler()
	return func(apply bool) (string, string) {
		user, ok := unitScope(otelenv.DaemonPath)
		if !ok {
			return string(service.UnitNA), ""
		}
		r := reconcile(user, !apply)
		return string(r.State), r.Detail
	}
}

// reconcileUnitAtStartup runs on every service start (not only after an update): a unit
// that predates the current template is re-rendered and daemon-reloaded, then the process
// exits so systemd (Restart=always) restarts it into the new unit. Anything else carries on.
func reconcileUnitAtStartup(
	daemonPath func() (string, error),
	reconcile func(userScope, dryRun bool) service.ReconcileResult,
	exit func(int),
	logf func(format string, args ...any),
) {
	user, ok := unitScope(daemonPath)
	if !ok {
		return
	}
	r := reconcile(user, false)
	switch r.State {
	case service.UnitReconciled:
		logf("agentpod-node: unit re-rendered from the current template (%s); restarting to load it", r.Detail)
		exit(0)
	case service.UnitCurrent, service.UnitNA:
	default:
		logf("agentpod-node: unit %s: %s", r.State, r.Detail)
	}
}

func reconcileUnitOnStart() {
	reconcileUnitAtStartup(otelenv.DaemonPath, daemonUnitReconciler(), os.Exit, log.Printf)
}
