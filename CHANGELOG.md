# Changelog

All notable changes to AgentPod are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning: [Semantic Versioning](https://semver.org/).

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
