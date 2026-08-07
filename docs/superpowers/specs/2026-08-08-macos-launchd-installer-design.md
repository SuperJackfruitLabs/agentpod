# macOS LaunchAgent Installer — Design

**Date:** 2026-08-08
**Goal:** `install.sh` on macOS produces a persistent node-agent (survives reboot, terminal close, crashes) via a per-user LaunchAgent, and `apn update` restarts correctly under launchd. Ships as v0.1.12.

## Scope

- `apps/node-agent/scripts/install.sh` — darwin branch installs and bootstraps a LaunchAgent.
- `apps/node-agent/internal/selfupdate` — darwin restart path via launchctl.
- Docs: DEPLOYMENT/OPERATING notes for the macOS service (status, logs, uninstall) and the logged-in/sleep limitation.

Out of scope: LaunchDaemon (pre-login root service), Windows, changes to the linux systemd paths.

## 1. install.sh darwin path

macOS installs are always rootless-per-user:

- Invoked via `sudo` (the console one-liner): re-exec the entire script as `$SUDO_USER` (extends the existing darwin enroll-as-`$SUDO_USER` special case to the whole install). Invoked as a normal user: proceed directly.
- Binary → `~/.local/bin/agentpod-node` (+ `apn` symlink), config → the user config dir, enroll as that user. The self-healing enroll (#161) makes re-runs safe: valid credential → keep, stale → re-enroll.
- Write `~/Library/LaunchAgents/dev.agentpod.node.plist`:
  - `Label` = `dev.agentpod.node`
  - `ProgramArguments` = [`<abs home>/.local/bin/agentpod-node`, `run`] (absolute path — launchd has no PATH)
  - `RunAtLoad` = true, `KeepAlive` = true
  - `StandardOutPath`/`StandardErrorPath` = `~/Library/Logs/agentpod-node.log`
- Bootstrap idempotently: `launchctl bootout gui/$UID/dev.agentpod.node` first (ignore failure), then `launchctl bootstrap gui/$UID <plist>`; if `bootstrap` is unsupported (older macOS), fall back to `launchctl load -w <plist>`.
- Final output tells the operator: status (`launchctl print gui/$UID/dev.agentpod.node`), logs path, uninstall (`launchctl bootout … && rm <plist>`).

`KeepAlive=true` also makes console one-click self-update work on macOS with no extra code: the update handler's delayed `os.Exit(0)` is respawned by launchd (same role systemd `Restart=always` plays on linux).

## 2. selfupdate restart on darwin

`restartService` currently shells to `systemctl` only; on macOS `apn update` swaps the binary then fails with a misleading "systemctl restart" hint. Add a darwin branch:

- `launchctl kickstart -k gui/<uid>/dev.agentpod.node` via the existing injected `RunCommand` seam (table-testable, no real launchctl in tests).
- On failure (agent not under launchd, e.g. a bare `apn run` terminal), the existing `ErrRestartFailed` path applies with a platform-correct message: restart it yourself (`launchctl kickstart -k gui/$UID/dev.agentpod.node` or re-run `apn run`).
- Runtime OS selects the branch (`runtime.GOOS`), keeping linux behavior byte-identical.

## Limitation (documented, by design)

A LaunchAgent runs only while the user is logged in, and system sleep suspends it. The node then reads honestly offline (45s sweeper) and reconnects on wake — correct behavior for a laptop node, not a defect.

## Testing / verification

- Go: table tests for the darwin restart branch through the injected RunCommand (asserting the exact launchctl argv), plus the existing linux cases stay green.
- Shell: install.sh has no test harness; keep the darwin branch small and verify live.
- Live dogfood on the Mac node: run the installer one-liner (existing valid credential → enroll keeps identity), kill the nohup'd agent, confirm the LaunchAgent connects (node online, `v: v0.1.12`), `launchctl kickstart -k` respawns it, and a console one-click update onto the NEXT release works when available.

## Release

Tag v0.1.12 (release assets carry the updated install.sh). Fleet linux nodes are unaffected but roll anyway to stay uniform.
