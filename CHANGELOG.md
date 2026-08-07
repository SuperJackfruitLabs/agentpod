# Changelog

All notable changes to AgentPod are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning: [Semantic Versioning](https://semver.org/).

---

## [0.1.10] - 2026-08-07

Trustworthy fleet: reconciliation, self-healing enrollment, and release hardening.

### Fixed

- **Heartbeat reconciliation & gateway closure** (#47)
  - Epoch-guarded gateway close: nodes gracefully reconnect when hub restarts (no stale socket held).
  - Heartbeat re-register: nodes refresh their registration on each heartbeat, catching enrollment drift.
  - Boot reset: on startup, hub resets all online nodes to offline (sweeper catchup → reconnect).
  - 45-second heartbeat sweeper: sweeps offline nodes and detects stale registrations.
  
- **Self-healing re-enrollment** (#161)
  - Nodes detect stored credential rejection and automatically re-enroll (even mid-session).
  - `enroll --force` CLI flag: operators can force re-enrollment to recover from credential drift.
  - New `/public/nodes/credential-check` endpoint: diagnostic check (no auth required) to validate credentials before enrollment.

### Changed

- **Authentication configuration tidying** (#149)
  - `BETTER_AUTH_SECRET` env var is now required; misconfiguration fails loudly at boot rather than silently degrading auth security.

### Improved

- **Release pipeline hardening** (#188)
  - Release workflow now retries failed arch builds up to 3 times (transient network flakes).
  - SHA256SUMS generation is decoupled from individual binary builds; SUMS publish even if one arch flakes.

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
