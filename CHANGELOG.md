# Changelog

All notable changes to AgentPod are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning: [Semantic Versioning](https://semver.org/).

---

## v0.1.22 - 2026-08-12

**Posture** — `apn scan`'s findings become fleet-visible, and, more urgently, become correct. Checking the scanner against real machines found it grading them **A** without opening the files it claimed to check.

### Fixed

- **`apn scan` reported false passes for Hermes and OpenClaw.** Its credential path list named files that exist on no machine we own — `config.json`, `credentials.json`, `gateway.json` — while the real files are `config.yaml`, `auth.json`, `.env`, `openclaw.json` and `gateway.systemd.env`. Not one path matched for either harness, so both graded clean having read nothing. The list is now rebuilt from running machines, and every entry carries the host and date it was verified on.
- **Per-station credentials were never checked at all.** Hermes keeps `auth.json`, `.env` and `config.yaml` in every profile; OpenClaw keeps `agent/auth.json`, `auth-profiles.json` and `auth-state.json` in every agent. A profile with world-readable credentials passed. Findings for these now carry the station they belong to.
- **A file's mode is not the same as its exposure.** A 644 file inside a 700 directory cannot be read by anyone else, and reporting it would be a false alarm. Every finding now requires *effective reachability* — the file grants read to a class **and** every ancestor directory grants traverse to it. Without this, correcting the paths above would have turned a correctly secured machine with 15 Hermes profiles into 15 criticals and a grade of F.

### Added

- **Station config directories are checked for being writable by others.** Files inside can all be owner-only while the directory holding them is group-writable, which lets another user *replace* an agent's credentials — invisible to any file-mode check.
- **`posture.scan`**, a node-level verb, surfaced as a Posture panel on the node page in the console. A station whose own credentials are exposed also shows a banner on its own page; host-wide findings stay on the node page rather than being repeated across every station sharing a harness.
- **Node-level capabilities**, carried in the `hello` frame. Because they ride the handshake they refresh on every connect, so they cannot go stale.

### Notes

- **Observe-only.** Nothing is stored and nothing is remediated from the console; findings carry the exact command to run. Continuous posture with staged remediation is a later horizon.
- **The fix only reaches a machine once that machine runs this release.** Until then `apn scan` there keeps reporting on the old path list.
- Verified on the fleet: superchotu went from ~5 checks to **48**, molt-bot from ~5 to **60** (55 of them per-station). Both still grade A — correctly, and now provably: superchotu's twelve `775` agent directories and molt-bot's fifteen `644` `config.yaml` files all sit under `700` ancestors, so all 27 would-be criticals are suppressed by the reachability rule rather than by luck.
- **No Windows support** — the reachability walk assumes POSIX mode bits.
- macOS binaries remain unsigned ([#228](https://github.com/rakeshgangwar/agentpod/issues/228), blocked on an Apple Developer account), so a macOS node re-prompts for permissions after self-updating.

---

## v0.1.21 - 2026-08-11

**Changesets** — see what an agent changed in a station's workspace without SSHing to the machine. Uncommitted edits, untracked files, and commits not yet on a base, in the console's new Changes tab.

### Added

- **`changeset.status`** — the summary for a station's workspace: the branch, the base, and the uncommitted and committed-not-on-base sides kept separate. They are different situations: one means the agent is mid-flight, the other means finished work is sitting on a machine.
- **`changeset.diff`** — a patch, whole-side or per-file, truncated on a rune boundary with the same contract as `fs.read`.
- **Untracked files are included.** Agents create files constantly and `git diff` shows none of them. Their content is fetched per-file rather than by staging them: `git add -N` would make them visible, but it writes to the index of a workspace an agent may be using.
- **The base says why it was chosen** — `explicit`, `upstream`, `default-branch` or `head`. A surprising diff on a machine you are not sitting at is otherwise unexplainable, and "no upstream, so you are only seeing uncommitted work" is a different situation from "diffed against your upstream". The chosen ref always resolves to its merge base with HEAD, so commits made on the base after the branch diverged do not show up as work the station never did.
- The capability is advertised **only** where the workspace is a git repository and `git` is usable, so stations without one show no tab rather than one that always errors.

### Fixed

- **A station's capabilities are now refreshed when its node connects.** `stations.capabilities` was previously written only at adoption, so a station adopted before a capability existed could never gain it — the node reported it on every detect and the hub kept serving the row it stored at adoption. Any new capability hit this. The refresh updates already-adopted rows only and never inserts; adoption stays an explicit act.

### Notes

- **Observe-only.** Nothing is stored: refresh and you get the workspace's current truth. Content-addressing a change and delivering it are a later horizon.
- **Requires a hub running the matching release.** The `/api/stations/:id/changeset/*` endpoints are new, and **the hub should be deployed before the fleet updates** — otherwise nodes advertise `changeset` to a hub that cannot refresh their stored capabilities, and no tab appears.
- Reads never mutate the repository, and run with `GIT_OPTIONAL_LOCKS=0` so they cannot contend with a working agent's own git operations.
- **No Windows support yet** — path handling assumes POSIX. Submodules report as the pointer moving, which is what `git` itself reports.
- macOS binaries remain unsigned ([#228](https://github.com/rakeshgangwar/agentpod/issues/228), blocked on an Apple Developer account), so a macOS node re-prompts for permissions after self-updating.

---

## v0.1.20 - 2026-08-11

**Doors** — reach a station from any ACP editor. `apn acp` makes a station on another machine look like a local agent to Zed, JetBrains, or anything else that speaks the Agent Client Protocol, including machines behind NAT or CGNAT, because the node dials out.

### Added

- **`apn acp --station <id>`** — spawned by an editor, it pipes the editor's stdio to the hub over WSS. It parses nothing: every protocol decision happens hub-side, where the ACP SDK lives, so `apn` carries no ACP library and no protocol version.
- **`apn acp --list`** — the stations you can attach an editor to, grouped by machine. Lists only stations that can actually host a session; an empty fleet and a fleet with no `acp`-capable stations get different messages, because they need different fixes.
- Attaching to an **existing** session replays its transcript, so joining a conversation mid-flight shows what has already happened rather than a blank pane.
- Permission prompts reach the editor. If the console is attached to the same session, **both are asked and the first answer wins**.

### Notes

- **This is the first release carrying `apn acp`.** On v0.1.19 and earlier the subcommand does not exist and an editor gets `unknown command` (exit 2).
- Requires a hub running **this release or later** — the `/api/acp/proxy` endpoint is new.
- Editor config uses the ACP custom-agent form, e.g. Zed's `agent_servers` entry with `"command": "apn"`, `"args": ["acp", "--station", "<id>"]`, and `AGENTPOD_TOKEN` in `env`. Prefer the environment variable over `--token`: a token on the command line lands in shell history and process listings.
- macOS binaries remain unsigned ([#228](https://github.com/rakeshgangwar/agentpod/issues/228), blocked on an Apple Developer account), so a macOS node re-prompts for permissions after self-updating.

---

## v0.1.19 - 2026-08-11

`apn scan` — a security check for the agent runtimes on a machine, needing no hub, no account and no network.

### Added

- **`apn scan`** checks the two ways an agent runtime gets taken over:
  - **Credential files other users can read.** Known credential paths per harness (openclaw, hermes, claude-code, codex, opencode) are checked for group- or world-readable modes. File *contents* are never inspected — telling someone their keys are exposed should not require reading their keys.
  - **Agents listening on every network interface.** A runtime bound to `0.0.0.0` or `[::]` rather than loopback is reachable by anything that can route to the box. Only agent processes are considered; this is not a general port audit.
- Graded report (`A`–`F`) with a specific remedy per finding, `--json` for scripting, and an exit code usable in cron: `0` clean, `1` warnings, `2` critical.
- A check that cannot determine an answer reports `unknown` and says why. It is never counted as a pass, and never worsens the grade either.

### Notes

- **Scope of the listener check:** harnesses driven over stdio — Codex, Claude Code and OpenCode under ACP — never bind a port, so on a machine running only those this check has nothing to report. It covers agents run in server mode, such as an OpenClaw gateway.
- **No CVE database.** Every check is a property of the machine as it is now, so the binary stays honest without needing updates.
- macOS binaries remain unsigned ([#228](https://github.com/rakeshgangwar/agentpod/issues/228), blocked on an Apple Developer account), so a macOS node will re-prompt for permissions after self-updating.

> Releases v0.1.14 – v0.1.18 were not written up here. They cover the ACP sessions program (multi-session, history, Claude Code and Codex adapters) and the UI revamp; see `git log v0.1.13..v0.1.18` for the detail.

---

## v0.1.13 - 2026-08-08

`apn` service CLI: status/stop/start/restart/logs, `service install`/`uninstall`, a grouped help system, and a thinner installer.

### Added

- **Service verbs** (#199)
  - `apn status [--json]`, `apn stop`, `apn start`, `apn restart`, `apn logs [-f] [-n N]` operate the node-agent's OS service (systemd on Linux, launchd LaunchAgent on macOS) through a new `internal/service.Manager`.
  - `apn stop` is sticky: it stops **and disables** the service so it doesn't respawn on its own; `apn start` re-enables and starts it.
  - `apn status` reports local service state (installed/enabled/running/version) plus hub reachability and credential validity; exits 0 only when both are healthy.
- **`apn service install` / `apn service uninstall`** (#199) — install or remove the platform service directly from the binary, backed by embedded service templates (systemd user/system units, launchd plist).
- **Help system** (#199) — grouped top-level help (`apn`, `apn help`, `-h`/`--help`), per-command help (`apn help <command>`), and did-you-mean suggestions for unknown commands. `-h`/`--help` now gates every command, including `stop`/`start`/`restart`/`run`/`detect`/`version`/`service` — previously only the four commands with a `flag.FlagSet` (enroll, update, status, logs) recognized `-h`; the others executed the real action (e.g. `apn stop -h` used to actually stop the service).

### Changed

- **Installer thinning** (#199) — `install.sh` no longer inlines the systemd unit heredoc or the LaunchAgent plist heredoc, and no longer downloads `agentpod-node.service` for a system install; it downloads the binary, enrolls, then delegates service setup to `"$DEST_BIN" service install`. The `.service` release asset still ships (for direct consumers) — the installer just stops fetching it.
- **`apn update`'s restart delegates to `internal/service`** (#199) — the darwin/linux restart logic in selfupdate now goes through `service.NewManagerForRestart` instead of hand-built `launchctl`/`systemctl` argv.

---

## v0.1.12 - 2026-08-08

macOS installer rootless improvements and launchd-native update restart.

### Added

- **macOS rootless installer** (#193)
  - Installs are now per-user and rootless; sets up a persistent launchd LaunchAgent (`~/Library/LaunchAgents/dev.agentpod.node.plist`) with RunAtLoad and KeepAlive enabled.
  - Logs are written to `~/Library/Logs/agentpod-node.log`.
  - Sudo invocations re-exec as the invoking user, including when the installer is piped (`curl | sudo bash`); installations are idempotent (bootout then bootstrap, with `load -w` fallback).
  - KeepAlive enables one-click self-updates on macOS: the node exits on update, and launchd respawns it.

### Changed

- **Update restart on macOS** (#193)
  - `apn update` now restarts via `launchctl kickstart -k gui/<uid>/dev.agentpod.node` on macOS instead of failing with a systemctl hint; Linux behavior unchanged.

### Fixed

- **Piped-invocation re-exec** (#193)
  - The sudo/darwin re-exec added by this release used `bash "$0"`, which resolves to the literal string `"bash"` (not a file) under a piped `curl | bash` invocation — every re-exec case (macOS root-with-`SUDO_USER`, and the generic Linux sudo escalation) failed with `bash: bash: cannot execute binary file`. Re-exec now re-fetches a runnable copy of the installer when `$0` isn't a real file on disk, so the documented piped one-liners work as shipped. A non-root macOS invocation also no longer wastes a needless sudo re-exec before dropping back to a user install.

### Limitations

- LaunchAgent runs only while the user is logged in; sleep suspends the node until wake (shown offline until login/wake).

---

## [0.1.10] - 2026-08-07

Trustworthy fleet: reconciliation, self-healing enrollment, and release hardening.

### Fixed

- **Heartbeat reconciliation & gateway closure** (#47)
  - Epoch-guarded gateway close: nodes gracefully reconnect when hub restarts (no stale socket held).
  - Heartbeat re-register: nodes refresh their registration on each heartbeat, catching enrollment drift.
  - Boot reset: on startup, hub resets all online nodes to offline (sweeper catchup → reconnect).
  - 45-second heartbeat sweeper: expires silent online nodes (no heartbeat for 3 missed 15s beats) and detects stale registrations.
  
- **Self-healing re-enrollment** (#161)
  - Nodes detect stored credential rejection and automatically re-enroll the next time `enroll` runs (install/boot) — not mid-session.
  - `enroll --force` CLI flag: operators can force re-enrollment to recover from credential drift.
  - New `/public/nodes/credential-check` endpoint: a stateless credential probe (requires `Authorization: Bearer <nodeId>:<nodeSecret>`) used by the agent's self-healing enroll to check whether its stored credential is still valid before deciding to re-enroll.

### Changed

- **Authentication configuration tidying** (#149)
  - Config now reads `BETTER_AUTH_SECRET` and passes it explicitly to `betterAuth()` (was `SESSION_SECRET`, which Better Auth never read).

### Improved

- **Release pipeline hardening** (#188)
  - Release workflow now retries failed release-asset uploads up to 3 times (transient network flakes); arch builds themselves are not retried.
  - SHA256SUMS generation is decoupled from individual binary builds; SUMS and static assets still publish even if one arch hard-fails.

---

## [0.1.0] - 2026-06-29

First tagged release of AgentPod **as a fleet/facilities console for agent runtimes**. The OpenCode era is frozen at [`v0.0.4-opencode`](#legacy-v004-opencode).

### Added

**Attach-first node-agent**
- Go static binary that dials out to the hub over WSS — no inbound ports, works behind NAT/CGNAT.
- Auto-reconnect with exponential backoff; heartbeat-based health.
- Systemd service unit with hardening directives; install script (`scripts/install-node-agent.sh`) is idempotent.
- Enrollment flow: operator mints a token → `agentpod-node enroll --hub <url> --token <token>` → node registers and opens the tunnel.

**Observe capabilities (read-only)**
- **Inventory** — enumerate stations (runtimes) per node, recursively; advertise per-station capabilities.
- **Health** — status (running/stopped/crashed), CPU/RAM/disk, uptime, restart count, last activity.
- **Logs** — live-tail and history via the harness's native log source; streamed as framed messages over the node tunnel.
- **Filesystem (read)** — list, read, download; path-jailed to the station's workspace root.

**Write operations + durable terminal**
- **Filesystem write** — write, rename, delete, upload; all operations audited.
- **Terminal** — interactive PTY shell scoped to the station workspace; durable and reattachable (node-agent holds the PTY master with scrollback buffer; tmux/dtach used when available).
- **Config edit** — read/edit known config files with automatic backup, diff preview, and clobber detection before every write; restore from backup.
- **Lifecycle** — start / stop / restart per station (harness-appropriate: Hermes process tree, OpenClaw systemd unit, etc.).
- **Cleanup** — per-station disk usage summary; prune caches, rotate logs, reclaim space.

**Harness descriptors**
- Descriptors ship for: **Hermes**, **OpenClaw**, **Claude Code**, **Codex**, **OpenCode**.
- Each descriptor wraps the harness's native CLI/API for detection, enumeration, path resolution, lifecycle, and logs — no hub logic in descriptors.

**Remote / hosted + Matrix identity**
- Subdomain cookie sharing (`Domain=.<your-domain>; Secure`) so the console (`console.`) and hub (`hub.`) subdomains share a session — the console deploys on Cloudflare Pages, the hub on a VPS, both under one registrable domain.
- Hermes stations: Matrix ID display + `matrix.to` deep-link in the station detail panel.

**Provisioning**
- Pluggable `provisioner` driver interface.
- **Docker driver** (dogfood-proven): provisions containers from `agentpod-node:local` (plain) or `agentpod-node-opencode:local` (OpenCode preloaded, opencode-ai@0.5.5); container auto-enrolls via `PROVISIONING_HUB_URL`; station auto-adopted immediately.
- **Cloudflare Sandbox driver**: implemented; live-unverified (see Known Limitations).
- Destroy: stop + remove container; clean up hub registry.

**Unified responsive console**
- Fleet-first information architecture: node list → station tree → capability panels.
- **Cmd-K palette**: quick navigation and actions across the fleet.
- **Activity ticker**: live feed of recent operations (file writes, terminal sessions, lifecycle events, config edits) with jump-to-station.
- Connect banner for offline/disconnected nodes.
- Legacy routes (`/projects`, `/workflows`) removed.

**Hub**
- Bun + Hono backend with Drizzle + Postgres (pgvector dropped).
- Better Auth with Drizzle adapter; first user auto-becomes admin, signup closes after first user.
- Node gateway: WSS endpoint + in-process broker (`node → socket` map).
- Enrollment token minting + validation.
- Audit log for all write operations.
- Hub auto-runs Drizzle migrations on startup.

### Known Limitations

- **Single-operator only.** v0.1.0 ships one admin account (tenant-of-one). The data model carries owner/tenant scope and is multi-tenant-ready, but org management, tenant-isolation enforcement, signup/onboarding for others, and billing/quotas are **out of v0.1.0**. Multi-tenancy is a deliberate post-release effort targeting **v0.2.0**.
- **Cloudflare provisioning live-unverified.** The Cloudflare Sandbox driver is implemented but has not been smoke-tested against a live CF Sandbox environment. Use the Docker driver for production provisioning.
- **No repo-clone / credential-injection in provisioning.** Provisioned containers start with the node-agent and harness binary only; cloning a repo or injecting API keys into the container is not yet automated.
- **Phase 2 legacy cleanup pending.** Hub OpenCode backend, `docker/` images, `cloudflare/worker`, Tauri removal, and `config/` infrastructure retirement (#135–139) are deferred to a post-v0.1.0 milestone.

---

## Legacy: v0.0.4-opencode

The previous AgentPod product (OpenCode-based cross-platform sandbox application: Tauri desktop, Docker containers, OpenCode AI coding agent) is frozen at tag **`v0.0.4-opencode`**. That codebase is recoverable from git history; archived documentation is under [`docs/archive/`](./docs/archive/). No parallel maintenance is planned.
