# apn Service CLI — Design

**Date:** 2026-08-08
**Goal:** `apn` absorbs platform service management (`stop|start|restart|status|logs` + `apn service install|uninstall`), gains a real help system, and `install.sh` thins to download → enroll → `apn service install`. Ships as v0.1.13.

## Command surface

All verbs are platform-aware (`runtime.GOOS`); label/unit contracts are unchanged: launchd `dev.agentpod.node` (gui/<uid> domain), systemd `agentpod-node` (`--user` or system).

| Verb | Semantics |
|------|-----------|
| `apn stop` | Stop **and disable** (sticky across reboot/login). macOS: `launchctl bootout` + `launchctl disable`; linux: `systemctl [--user] stop` + `disable`. Prints undo hint. |
| `apn start` | Enable + start (symmetric inverse of stop). macOS: `launchctl enable` + `bootstrap`; linux: `enable --now`. No service installed → helpful error pointing at `apn service install` / foreground `apn run`. |
| `apn restart` | `launchctl kickstart -k` / `systemctl [--user] restart`. |
| `apn status` | Local block: service installed / enabled / running (PID), binary version, config present, hub URL, nodeId. Hub block: reachability + credential validity via existing `GET /public/nodes/credential-check`. Exit 0 iff running AND credential valid (scriptable). `--json` for machine output. |
| `apn logs [-f] [-n N]` | macOS: read/tail `~/Library/Logs/agentpod-node.log`. linux: exec `journalctl [--user] -u agentpod-node [-f] [-n N]`. |
| `apn service install` | Write plist/unit from a template **embedded in the binary**, enable + start. Idempotent (re-install replaces file, restarts). Non-root linux → `--user` unit; root linux → system unit; macOS → LaunchAgent (root macOS: refuse, per installer policy). |
| `apn service uninstall` | Stop + disable + remove plist/unit. Idempotent (no-op when absent). Leaves config/enrollment untouched (that's `unenroll`, future). |

## Structure

New `internal/service` package:

- `type Manager interface { Install() error; Uninstall() error; Start() error; Stop() error; Restart() error; Status() (Status, error) }`
- `launchdManager` + `systemdManager` implementations selected by GOOS (+ systemd user-vs-system by uid/unit presence, mirroring `selfupdate.restartService`'s probe).
- All exec through an injected runner (same seam as `selfupdate.Options.RunCommand`) → every branch table-testable, asserting exact argv sequences.
- Templates: `//go:embed` plist + unit text, parameterized on binary path (absolute, via `os.Executable` + `EvalSymlinks`) and log path.
- `selfupdate.restartService` refactors to delegate to `service.Restart` — one restart implementation. Behavior contract (exact argv on both platforms) preserved by existing tests.
- `main.go` gains the verbs; existing `enroll|run|detect|update|version` unchanged.

## Help & CLI UX

Today `apn` prints a bare `usage: agentpod-node <enroll|run|detect|update|version>` and nothing else. This slice gives it a real help system — stdlib only (no cobra; the binary stays dependency-light):

- `apn` (no args), `apn help`, `apn -h` / `apn --help` → structured help: one-line description of the tool, usage line, commands grouped by purpose with one-line descriptions, a short examples block, and the version.

```
agentpod-node (apn) — AgentPod fleet node agent  v0.1.13

Usage: apn <command> [flags]

Service:
  status      Show local service + hub connection state (--json for scripts)
  start       Enable and start the background service
  stop        Stop and disable the service (sticky across reboots)
  restart     Restart the running service
  logs        Show service logs (-f to follow, -n N for last N lines)
  service     install | uninstall the platform service (launchd/systemd)

Node:
  enroll      Enroll this machine with a hub (--hub, --token, --force)
  run         Run the agent in the foreground
  detect      Print detected harness stations as JSON

Maintenance:
  update      Self-update from the latest release (--check, --force)
  version     Print version and platform

Examples:
  apn status
  apn logs -f
  apn enroll --hub https://hub.example.com --token <TOKEN>

Run 'apn help <command>' or 'apn <command> -h' for command details.
```

- `apn help <command>` and `apn <command> -h` → per-command help: purpose, flags (each FlagSet gets proper `Usage` text — several currently print bare flag defaults), platform notes where behavior differs (e.g. `stop` semantics, where `logs` reads from).
- `apn <unknown>` → "unknown command" + the closest match if the edit distance is small ("did you mean 'status'?") + pointer to `apn help`. Exit 2.
- Help text lives beside the command definitions in `main.go`/a small `help.go`, asserted by unit tests (every registered command appears in top-level help; help exits 0; unknown command exits 2).

## Installer thinning

`install.sh` keeps: OS/arch detection, sudo/re-exec handling, binary download + atomic swap, enroll. Its linux systemd block and macOS `install_launch_agent()` are replaced by one call: `apn service install` (run as the target user). The static `agentpod-node.service` release asset continues to ship for direct consumers, marked as reference — the installer no longer downloads it.

## Interactions

- Self-update (console-driven) never disables; KeepAlive/systemd-restart respawn semantics are untouched by the sticky-stop feature (only `apn stop` disables).
- A stopped node reads honestly offline in the console (sweeper) with last-seen preserved.
- `status`'s hub block reuses the node's stored credential; no new endpoints.

## Testing

TDD. Table tests per manager per verb (argv exactness, error paths); status hub-block against `httptest` (200/401/unreachable); `logs` argv/`tail` behavior unit-tested with a temp log file. Live dogfood on the Mac node before tagging: `service install` (over the existing agent) → `status` (running + credential valid) → `stop` → verify disabled via `launchctl print-disabled` → `start` → `logs -n 5` → console shows offline/online transitions honestly. Then release v0.1.13, roll fleet, update DEPLOYMENT/OPERATING/CLAUDE.md command references.

## Out of scope

`doctor`, `unenroll`, `config get/set`, `--json` beyond status, Homebrew tap, Windows, operator/fleet verbs.
