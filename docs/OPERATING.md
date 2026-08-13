# AgentPod — Operator Guide

Day-2 operations: enrolling nodes, adopting stations, driving capability panels, and provisioning runtimes.

> **Single-operator note.** v0.1.0 targets one admin account. The first user to sign up becomes admin; signup is automatically disabled after that.

---

## 1. Enroll a node

A **node** is any host running the AgentPod node-agent — a VPS, a laptop, a provisioned container. The node-agent dials *out* to the hub over WSS; no inbound ports are required.

### Option A — curl installer (recommended — no Go / no repo needed)

On the target host (Linux or macOS). **System-wide** (root; installs a systemd service):

```bash
curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh \
  | sudo bash -s -- https://hub.<your-domain> <enrollment-token-from-console>
```

**Rootless** — for key-only hosts where the login user has no `sudo` password. Pass `--user`; it installs into `~/.local/bin`, enrolls as you, then runs `apn service install` (systemd `--user` on Linux) — falling back to run instructions (`apn run` / `tmux`) if no user service manager is available:

```bash
curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh \
  | bash -s -- --user https://hub.<your-domain> <enrollment-token-from-console>
```
(If not root and `sudo` is absent, the installer auto-falls back to this rootless mode. For a `systemd --user` service to survive logout/reboot, run `sudo loginctl enable-linger <user>` once.)

**macOS** — the same one-liner (with or without `sudo`/`--user`) always installs rootless: binary in `~/.local/bin`, enrolled as the invoking user, service registered via `apn service install` as a per-user LaunchAgent (label `dev.agentpod.node`). The `curl | sudo bash` form above re-execs itself as `$SUDO_USER` automatically, piped invocation included.

Manage the service with the `apn` verbs, on either platform:

```bash
apn status              # installed / running / hub reachability
apn logs -f             # follow service logs
apn restart             # restart in place
apn stop                # stop and disable (sticky — survives reboot until `apn start`)
apn start                # re-enable and start
apn service uninstall   # stop, disable, and remove the service
```

A LaunchAgent only runs while you're logged in — system sleep suspends it, and the node shows offline until wake (by design).

The installer downloads the prebuilt binary for your platform (linux/darwin × amd64/arm64) from the latest GitHub Release, then — for a **system-wide Linux install (root, no `--user`)**:
1. Installs it to `/usr/local/bin/agentpod-node`.
2. Runs `agentpod-node enroll --hub <HUB_URL> --token <TOKEN>` — writes config to `/root/.config/agentpod-node/config.json`.
3. Runs `apn service install`, which installs and enables the systemd unit `agentpod-node.service`.

(Rootless and macOS installs use the different paths and service mechanism described above instead.)

The installer is idempotent: re-running upgrades the binary, re-enrolls, and re-installs the service. Binaries are published on every `v*` tag by `.github/workflows/release-node-agent.yml`.

> **Under the hood:** the `apn` verbs wrap the native service manager — on Linux, `systemctl [--user] status|restart|stop|start|enable|disable agentpod-node` + `journalctl [--user-unit|-u] agentpod-node -f`; on macOS, `launchctl print/kickstart/bootout gui/$(id -u)/dev.agentpod.node` + `tail -f ~/Library/Logs/agentpod-node.log`. Reach for the raw commands only when diagnosing the service manager itself — `apn status` / `apn logs` / `apn restart` are the day-to-day path.

### Option A′ — from a repo checkout (build from source)

If you have the repo checked out and Go available:

```bash
sudo bash /path/to/agentpod/apps/node-agent/scripts/install-node-agent.sh \
    https://hub.<your-domain> \
    <enrollment-token-from-console>
```

This script resolves or builds the `agentpod-node` binary locally before installing. Idempotent.

### Option B — manual enroll + run

> The installers also create a short alias **`apn`** → `agentpod-node`, so `apn run`, `apn enroll`, etc. work interchangeably with the full name.

```bash
# 1. Enroll once (writes config):
apn enroll --hub https://hub.<your-domain> --token <TOKEN>

# 2. Run (reads config automatically):
apn run
# Or, let apn manage it as a persistent service (systemd on Linux, LaunchAgent on macOS):
#   apn service install
```

### Verify enrollment

```bash
apn status
apn logs -f
# Expected: "connected to hub" — the node appears online in the console, labelled "no tunnel"
```

In the console, navigate to **Nodes** — the enrolled host should appear with status **online**.

### Generating enrollment tokens

In the console: **Settings → Nodes → New token**. Tokens are single-use and scoped to the operator account.

---

## 2. Adopt stations

After a node connects, AgentPod runs its harness descriptors to detect runtimes on the host. Each detected runtime appears as a **station** (what the design calls a cubicle) in the console's station list.

**Detect → Adopt:**

1. Open the node in the console. The station list shows discovered runtimes with status `detected`.
2. Click **Adopt** on a station to bring it under management. Adopting does not restart or modify the runtime.
3. The station moves to `adopted` status and its capability panels become active.

Stations are discovered per harness:

| Harness | Discovery mechanism |
|---------|-------------------|
| **Hermes** | Reads `~/.hermes/profiles/` + `hermes profile` output |
| **OpenClaw** | Reads `~/.openclaw/agents/` |
| **Claude Code** | Project paths read from `~/.claude.json` (fallback: `~/.claude/projects/` enumeration) |
| **Codex** | Project paths read from the `[projects."<path>"]` tables in `~/.codex/config.toml` |
| **OpenCode** | Worktree paths read from `opencode.db` (fallback: project dir enumeration) |

---

## 3. Drive a station

Click a station to open its capability panels. Available panels depend on which capabilities the harness descriptor advertises for that station.

### Health

Shows: running/stopped/crashed status · CPU, RAM, disk usage · uptime · restart count · last activity timestamp. Refreshes automatically; click the refresh icon to force a poll.

### Logs

Live-tailing log stream from the runtime. The descriptor uses the harness's native log source (e.g. `hermes logs`, `~/.openclaw/logs/`, process stdout).

- **Tail** — streams new lines as they arrive.
- **History** — scrolls back through buffered lines.
- Logs are streamed over the node tunnel as framed messages; no polling.

### Terminal

An interactive PTY shell scoped to the station's workspace root. Backed by the node-agent's durable PTY keepalive (or tmux/dtach when available on the host), so the session survives console/network disconnects.

- Reconnecting to the console re-attaches the existing session; the running command and scrollback are preserved.
- The shell is **path-jailed** to the cubicle root — it cannot traverse to sibling workspaces.

### Files

A file browser for the station's workspace. Supports: list · read · write · rename · delete · upload · download.

All write operations are **audited** (recorded in the hub's activity log).

### Config

Read and edit the station's known config files (e.g. `~/.hermes/config.yaml`, `~/.openclaw/openclaw.json`, `.claude/settings.json`). Before any write, the hub:

1. Takes a **backup** of the current file (timestamped, kept on the node).
2. Shows a **diff** of the proposed change.
3. Detects if the file was modified externally since last read (**clobber detection**).

Use **Restore** to revert to the most recent backup.

### Lifecycle

Start / stop / restart the station's runtime. Behaviour is harness-specific:

| Harness | Lifecycle mechanism |
|---------|-------------------|
| Hermes | Per-profile process (`hermes -p <name> gateway run`) supervised by the main gateway |
| OpenClaw | User systemd unit (`openclaw-gateway.service`) |
| Claude Code / Codex | Ephemeral CLI (no persistent process; lifecycle not applicable) |

### OpenClaw agent sessions (ACP)

Stations advertising the `acp` capability get a **Chat** tab — a real conversation with the agent, driven over the Agent Client Protocol. For OpenClaw the node-agent spawns `openclaw acp`, which is a **bridge to the OpenClaw Gateway**, not a standalone runtime.

Prerequisites:

- **OpenClaw ≥ 2026.1.20** on the node (that release added the `acp` subcommand).
- **The `openclaw` binary must be findable.** The node-agent resolves it, in order: the `openclawBinary` config key (used verbatim) → `PATH` → the well-known install paths `~/.local/share/pnpm/openclaw`, `~/.local/bin/openclaw`, `/usr/local/bin/openclaw`, `/usr/bin/openclaw`, `/opt/homebrew/bin/openclaw` (first one that exists and is executable; symlink shims are followed). If none resolves, opening a session fails immediately with `Couldn't start the agent process — openclaw: couldn't find the openclaw binary on this node — set openclawBinary in the node config`.
- **The OpenClaw Gateway must be running.** The bridge dials it over WebSocket. If no Gateway is running on the node and no remote URL is configured, opening a session fails immediately with `Couldn't start the agent process — openclaw: the OpenClaw gateway isn't running on this node — start it before opening a session` rather than hanging until the handshake times out. (When both the binary and the Gateway are missing, the binary is reported first — nothing can start without it.)

> **PATH gotcha — systemd user service.** The node-agent usually runs as a `systemctl --user` unit whose `Environment=` is empty, so it inherits systemd's minimal default `PATH` (`/usr/local/bin:/usr/bin:/bin` and friends). A **pnpm or npm-global install** of openclaw lives under `~/.local/share/pnpm` or `~/.local/bin` — invisible to that `PATH`, even though `openclaw` works fine in your interactive shell. That is why the well-known paths are probed; if your install is somewhere else again, set `openclawBinary` to the absolute path (`which openclaw` in a login shell tells you which) and `apn restart`.

A default local install needs **no configuration** — openclaw resolves the Gateway URL and credentials from its own config. Four optional node config keys override that (`~/.config/agentpod-node/config.json`, or `~/Library/Application Support/agentpod-node/config.json` on macOS):

```json
{
  "openclawBinary": "/home/openclaw/.local/share/pnpm/openclaw",
  "openclawGatewayUrl": "wss://gateway.internal:18789",
  "openclawTokenFile": "/etc/agentpod/openclaw.token",
  "openclawSessionLabel": "console"
}
```

| Key | Flag | Meaning |
|-----|------|---------|
| `openclawBinary` | `argv[0]` | Absolute path to the `openclaw` executable. Used verbatim, skipping `PATH` and the well-known-path probe. |
| `openclawGatewayUrl` | `--url` | Point at a remote Gateway. When set, the local Gateway check is skipped. |
| `openclawTokenFile` | `--token-file` | **Path to a file** containing the Gateway token. |
| `openclawSessionLabel` | `--session` | Session component of the OpenClaw session key; default `main`. |

The token is always passed as a **file path, never inline** — argv is world-readable via `ps`, so the node-agent never emits `--token`. Keep the token file `0600` and owned by the user running the node-agent.

Work is addressed by OpenClaw session key `agent:<name>:<label>`: the root `openclaw` station maps to `agent:main:<label>`, and a subagent station `openclaw:<agent>` maps to `agent:<agent>:<label>`. Restart the node-agent (`apn restart`) after changing any of these keys.

### Claude Code agent sessions (ACP)

Claude Code has **no ACP mode of its own**. Its stations get a **Chat** tab via an external adapter, [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) — a Node program that speaks ACP on stdio and drives Claude Code underneath. The node-agent runs it in the station's **project directory**, the same path the Files, Health and Cleanup tabs use.

Prerequisites:

- **Node 22 or newer** on the node. The adapter requires it. The node-agent reads `node --version` (bounded, 2s) before spawning and fails fast with `Couldn't start the agent process — claude-code: node 22+ is required by claude-agent-acp (found v20.11.1)` rather than letting the adapter crash after the session is open. Two deliberate exemptions: a node it can't find, or that won't report a version, is **not** a failure (an adapter may ship its own runtime), and the check is **skipped entirely when you set `claudeCodeAcpBinary`** — naming your own adapter means taking responsibility for the runtime it uses, which may be one it execs itself.
- **The adapter must be reachable.** Resolution order: the `claudeCodeAcpBinary` config key (used verbatim) → a `claude-agent-acp` on `PATH` → the well-known install paths `~/.local/share/pnpm/`, `~/.local/bin/`, `/usr/local/bin/`, `/usr/bin/`, `/opt/homebrew/bin/` → a version-pinned `npx -y @agentclientprotocol/claude-agent-acp@0.66.0`. If not even `npx` resolves, opening a session fails immediately with `Couldn't start the agent process — claude-code: couldn't find claude-agent-acp or npx on this node — set claudeCodeAcpBinary in the node config`.
- **Credentials come from the host.** The adapter uses the Claude Code install already on the node and whatever it is already authenticated with — the node-agent passes no API key, token or secret in argv (world-readable via `ps`) or in the environment. If `claude` isn't logged in on that host, the session won't be either.

> **The npx version is pinned on purpose.** A bare `npx -y @agentclientprotocol/claude-agent-acp` would change every node's adapter the moment a new version is published — mid-flight, with no record of which version a session ran. Installing the adapter properly (`pnpm add -g @agentclientprotocol/claude-agent-acp`) is faster to start and is preferred on a node that hosts sessions regularly; bumping the pinned fallback is a node-agent release.

> **Install skew.** The node-agent sets `CLAUDE_CODE_EXECUTABLE` to the `claude` it resolves on the node (same order: `claudeCodeBinary` → `PATH` → well-known paths). Without it the adapter drives the Claude Code build bundled with its own SDK, so the Chat tab and the Health tab would be reporting two different installs — different version, different config, different session history. When no `claude` resolves at all, the variable is left unset rather than pointed at a path that doesn't exist.

A host with node and `claude` on the service's `PATH` needs **no configuration**. Three optional keys cover the rest (`~/.config/agentpod-node/config.json`, or `~/Library/Application Support/agentpod-node/config.json` on macOS):

```json
{
  "claudeCodeAcpBinary": "/home/pod/.local/share/pnpm/claude-agent-acp",
  "claudeCodeBinary": "/home/pod/.local/bin/claude",
  "nodeBinary": "/opt/node-22/bin/node"
}
```

| Key | Effect |
|-----|--------|
| `claudeCodeAcpBinary` | `argv[0]`: absolute path to a `claude-agent-acp` executable. Used verbatim, skipping `PATH`, the well-known-path probe and the npx fallback. |
| `claudeCodeBinary` | Absolute path to the `claude` CLI, exported as `CLAUDE_CODE_EXECUTABLE`. |
| `nodeBinary` | Absolute path to a `node` runtime to use **instead of** the one on the service's `PATH`. When it satisfies Node 22 it becomes the runtime the adapter actually runs under: its directory is prepended to the session's `PATH` and its `npx` is preferred over `PATH`'s. |

**How `nodeBinary` is chosen.** It is an escape hatch for supplying a *good* runtime, never for downgrading a working one, so the node-agent uses the first of `nodeBinary` then `PATH` that satisfies Node 22:

- apt node 18 on `PATH`, `nodeBinary` → node 22: the configured one wins **for the spawn as well as the check** — `PATH`'s `npx` belongs to node 18, and `npx` finds `node` through `PATH`, so gating on one runtime and spawning under another would produce exactly the crash the gate exists to prevent.
- `PATH` → node 22, `nodeBinary` → something older or mistyped: the session runs on `PATH`'s node 22 and is **not** refused. A stale key in a config file shouldn't cost you a session that works. (A `nodeBinary` that can't report a version at all falls through to `PATH` for the same reason — a typo degrades to a check against the real runtime, not to no check.)

The same **PATH gotcha as OpenClaw** applies, and bites harder here: under a `systemctl --user` unit, an nvm- or fnm-managed node is invisible (those live under `~/.nvm/versions/...`, which is not probed) — set `nodeBinary` to the absolute path from `which node` in a login shell. Restart the node-agent (`apn restart`) after changing any of these keys.

### Codex agent sessions (ACP)

Codex has **no ACP mode of its own** either. Its stations get a **Chat** tab via [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp) — a Node program that speaks ACP on stdio and drives `codex app-server` underneath. The node-agent runs it in the station's **project directory**, the same path the Files, Health and Cleanup tabs use.

- **The adapter must be reachable.** Resolution order: the `codexAcpBinary` config key (used verbatim) → a `codex-acp` on `PATH` → the well-known install paths `~/.local/share/pnpm/`, `~/.local/bin/`, `/usr/local/bin/`, `/usr/bin/`, `/opt/homebrew/bin/` → a version-pinned `npx -y @agentclientprotocol/codex-acp@1.1.14`. If not even `npx` resolves, opening a session fails immediately with `Couldn't start the agent process — codex: couldn't find codex-acp or npx on this node — set codexAcpBinary in the node config`. The pin exists for the same reason as claude-code's, and bumping it is a node-agent release.
- **No Node version gate.** Unlike `claude-agent-acp` (which declares `node >= 22`), `codex-acp` declares **no `engines` field at all** — so the node-agent selects a runtime but never refuses a session over its version: inventing a floor the package never asked for would cost sessions on hosts it actually supports. `nodeBinary` still works exactly as it does for claude-code, with one difference that follows from the missing requirement: since there is no minimum to judge an "old" runtime against, a configured `nodeBinary` always wins the spawn (its directory is prepended to the session's `PATH` and its `npx` is preferred over `PATH`'s) rather than being stepped over in favour of a newer `PATH` node. A `nodeBinary` that can't report a version at all — a typo — still falls through to `PATH` untouched. With **no** `nodeBinary` set, no `node --version` runs at all on the Codex path: with nothing to enforce and nothing to prefer, the result couldn't change the command, and a node on a stalled mount would otherwise cost every session opening the full 2s probe timeout.
- **`NO_BROWSER=1` is always set.** It hides the browser-based ChatGPT login, which is meaningless on a headless fleet node: nobody is sitting at that host to complete an OAuth round trip, and offering the method only produces a session that hangs on auth. A live handshake against the adapter confirms the consequence — with it set, the only auth method advertised is `api-key` (`initialize` → `protocolVersion: 1`, `authMethods: ["api-key"]`, `loadSession: true`), which is what makes the service-environment key below the practical route on a fleet node.
- **`INITIAL_AGENT_MODE=agent` is always set** — the approval-seeking mode, chosen by us and never inherited from the adapter's default. This matters more than it looks: the console gives a station its **Chat** tab based on the `acp` capability alone, so every Codex project on a node gains one as soon as that node updates, and the hub's `ask` / `accept-edits` / `full-auto` modes are only a safety net *if the agent actually sends a permission request*. AgentPod **never** opts a fleet node into Codex's `agent-full-access` mode, and there is no config key to do so: an unattended host is the worst place to hand an agent unprompted write-and-execute. If you want a Codex station to act without asking, that is a decision to make per turn in the console, not a default baked into the node.

**Authentication is the node's, not AgentPod's.**

1. **API key in the SERVICE environment — the route to use.** With `NO_BROWSER=1` the adapter advertises `api-key` and nothing else, so this is what a fleet node actually authenticates with. `codex-acp` reads `CODEX_API_KEY` (preferred) or `OPENAI_API_KEY` from the environment it **inherits** from the node-agent — so put the key in the service unit, not anywhere AgentPod reads:

   ```ini
   # systemd: ~/.config/systemd/user/agentpod-node.service.d/codex.conf
   [Service]
   EnvironmentFile=/home/pod/.config/agentpod-node/codex.env   # chmod 0600, contains CODEX_API_KEY=sk-...
   ```

   On macOS, the equivalent is an `EnvironmentVariables` entry in the LaunchAgent plist — or, better, keep the key in a `0600` file referenced from a wrapper, never inline in a world-readable plist. Restart the node-agent (`apn restart`) so the new environment is inherited; a key added without a restart changes nothing.

2. **ChatGPT login.** A one-time interactive `codex login` on the node (over SSH, or via the station's own Terminal tab) writes credentials under `~/.codex/`. Note that this is *not* the method the adapter advertises under `NO_BROWSER=1`, so treat it as unproven for Chat until a live session says otherwise — and note that stored credentials belong to the node's own `codex`, which by default is **not** the Codex the adapter runs (see below).

> **There is deliberately no `codexApiKey` config key, and there never will be.** The node config feeds argv and child environments, and argv is world-readable via `ps` — a key there would be visible to every process on the host. The node-agent passes **no** key, token or secret in argv or in the environment it adds; it only ever lets the service's own environment through.

> **The adapter brings its own Codex, and by default we let it.** `codex-acp` bundles a Codex build it is known to work with (1.1.14 ships 0.147.0), and AgentPod deliberately does **not** point it at the node's own `codex` CLI. That is the reverse of the claude-code case, for a concrete reason: `codex-acp` drives one specific interface, `codex app-server`, and a CLI that predates it has no such subcommand — it falls into interactive mode and dies instantly on a TTY a fleet node doesn't have. The symptom, if you ever see it:
>
> ```
> Codex process has exited with code 1: Error: Device not configured (os error 6)
> ```
>
> That is a Codex older than `app-server` (confirmed on Homebrew's `codex 0.36.0`, where `codex --help` lists no `app-server`). Check with `codex app-server --help` on the node.
>
> `codexBinary` is the **opt-in** escape hatch for the opposite case — your `codex` is recent enough, and you want the session on the same install the Health tab reports on. Set it and it is used verbatim; leave it unset and nothing is volunteered, because auto-discovery cannot tell a new CLI from one that will kill every session. There is no version probe: naming the key is the assertion.

A host with node (or just `npx`) on the service's `PATH` needs **no configuration** — and note that a node's own `codex` install is not required at all, since the adapter brings its own. The optional keys:

```json
{
  "codexAcpBinary": "/home/pod/.local/share/pnpm/codex-acp",
  "codexBinary": "/home/pod/.local/bin/codex",
  "nodeBinary": "/opt/node-22/bin/node"
}
```

| Key | Effect |
|-----|--------|
| `codexAcpBinary` | `argv[0]`: absolute path to a `codex-acp` executable. Used verbatim, skipping `PATH`, the well-known-path probe and the npx fallback. |
| `codexBinary` | **Opt-in.** Absolute path to a `codex` CLI that exposes `app-server`, exported as `CODEX_PATH`. Never auto-discovered; unset means the adapter's own bundled Codex. |
| `nodeBinary` | Shared with claude-code: the `node` runtime to use instead of the service `PATH`'s. |

Restart the node-agent (`apn restart`) after changing any of these keys.

### Cleanup

Disk usage summary for the station's workspace. Actions: prune caches · rotate logs · reclaim space. Each cleanup action shows the bytes to be freed before applying.

---

## 4. Provision a runtime

Provisioning creates a new container with the node-agent baked in, which auto-enrolls and auto-adopts as a station. The management UX is identical to an attached host.

### Docker provisioner (dogfood-proven)

**From the console:**

1. Click **New runtime** (or open the Cmd-K palette → "New runtime").
2. Select **Docker** as the provider.
3. Choose a harness (e.g. **OpenCode** → uses the `agentpod-node-opencode:local` image).
4. Click **Create**.

The hub starts the container. The node-agent inside it auto-enrolls via `PROVISIONING_HUB_URL`. Within seconds, the new node appears online and the station is auto-adopted — ready to drive.

**Destroy a provisioned runtime:**

Open the runtime's detail panel → **Destroy**. This stops and removes the container. The station and node records are cleaned up from the hub registry.

### Cloudflare provisioner

Available in the UI if `ENABLE_CLOUDFLARE_SANDBOXES=true` is set in the hub env. Status: **live-unverified in v0.1.0** — use Docker for production provisioning.

### Modal provisioner

Available in the **New runtime** provider list if `ENABLE_MODAL_PROVISIONING=true` is set in the hub env. Configuration: see the `── Provisioning ──` block in `docs/DEPLOYMENT.md`.

#### Cost, before anything else

Modal **Sandboxes** carry roughly a **3× premium over standard Modal compute**, and they bill **wall-clock for as long as the sandbox exists** — not CPU burned. A sandbox sitting at 0% CPU waiting for its operator costs the same as one working flat out. A minimal always-on runtime is about **$21/month**; **Volumes bill separately**, on stored bytes, and keep billing until they are deleted.

A mostly-idle fleet is therefore Modal's worst case, and AgentPod fleets are mostly idle. Modal earns its place for short, bursty, isolated work — a runtime you create, use, and destroy the same day. For a long-lived station that sits waiting for someone to open a terminal, Docker is cheaper by a wide margin and Cloudflare sleeps when idle where Modal does not.

> Pricing figures are Modal's published rates read on **2026-08-13**. Re-check them before turning this on; nothing in the hub reads Modal's price list, and nothing here will tell you if it moves.

#### What a Modal runtime actually is

**A rolling series of disposable sandboxes anchored by one named Volume.** The Volume is named `agentpod-<runtime id>`, holds the workspace at `/workspace`, and outlives every sandbox. The sandbox is disposable and always will be.

That shape is not an optimisation. Probed against a real Modal account on **2026-08-13**:

- `terminate` is **irreversible**, and Modal has **no start verb at all**. Every restart is a new sandbox with a new id and a fresh root filesystem.
- Every sandbox is destroyed by the platform at **24 hours**, however healthy it is, with **no warning and no callback**. Nothing in Modal's API rotates for you.
- A Volume mounted **by name** does carry a workspace from one sandbox to the next — a different sandbox id read back a sentinel the previous one wrote. This single fact is what makes Modal usable.
- Modal's **idle** timer is opt-in and off by default, and AgentPod never opts in. A busy-but-quiet station is not reaped the way a Cloudflare sandbox was on 2026-08-12.

Anything written outside `/workspace` — including anything in `$HOME` — is written in sand. That is deliberate for `$HOME`: the node-agent's `config.json` holds the node id and node secret, and keeping it on the disposable root filesystem means no credential is ever left at rest in shared storage. Every new sandbox enrols afresh, the hub resumes the same node with a rotated secret, and the runtime keeps its node id and its history.

#### The 24-hour ceiling, and rotation

Left alone, a Modal station would simply die once a day. The hub does not leave it alone.

`sweepExpiringRuntimes` runs on the existing 15-second sweeper tick and re-creates a runtime's sandbox **30 minutes before the ceiling**, i.e. at about 23h30m of instance age. It re-provisions with the **same runtime id**, so the volume name is the same and the workspace is re-attached; the station re-enrols and **keeps its node id**.

What you see, per runtime, roughly once a day:

1. The status goes to **`provisioning`** for a moment as the sweeper claims the row, then to **`starting`**, both carrying the `statusReason`:
   *"re-created before this substrate's 24h instance lifetime ceiling destroyed it — the workspace is anchored outside the instance and carries over"*.
2. The runtime returns to **`online`** once the new sandbox's node-agent enrols — usually within seconds.
3. Files under `/workspace` carry over. **Processes do not.** Anything running inside the sandbox — a long-lived agent session, a dev server, a `tmux` you left attached — is gone. Treat a Modal station as something that restarts nightly.

Rotation is deliberately narrow, and each narrowing is a refusal to spend money:

- **Only `online` and `starting` rows rotate.** A `stopped`, `asleep`, `stopping`, `error` or `destroyed` runtime is never rotated. Age alone would always say a stopped runtime is due, and resurrecting one starts a sandbox nobody asked for that bills wall-clock until a human notices.
- **Age only.** The substrate is never asked whether the sandbox is alive. A sandbox that crashed in its first minute will crash the same way again, and re-creating it would rebuild and re-bill it every 15 seconds with nobody watching. The node going offline already surfaces that; **Start** is one click for the human who looks.
- **If the re-create fails**, the runtime goes to `error` with a reason naming the ceiling, rather than staying `online` and asserting health up to the moment it vanishes.

#### `MODAL_MAX_LIFETIME_MS` — read this before setting it

Optional, in milliseconds, clamped to 24 hours: it can only ever **shorten** the ceiling. It is read by the driver at hub startup, is **not** validated at boot, and an unset or unparseable value falls back to 24 hours silently. It is also handed to Modal as the sandbox's own timeout, so shortening it genuinely makes Modal kill the sandbox sooner — which is what makes it honest for a rotation drill.

The rotation margin is **`min(30 minutes, ceiling ÷ 2)`**, not a flat 30 minutes. So:

| Ceiling | Rotates at instance age |
|---|---|
| 24h (default) | 23h30m |
| 2h | 1h30m |
| 60m | 30m (the midpoint) |
| 30m | 15m (the midpoint) |
| 10m | 5m (the midpoint) |

Anything **60 minutes or less rotates at the midpoint**. The clamp is deliberate and load-bearing: with a flat 30-minute margin, any ceiling under 30 minutes makes the rotation threshold negative — every instance is born past due, and the hub bills a brand-new sandbox on **every 15-second tick**, forever, with no human in the loop.

To rehearse rotation without waiting a day, set `MODAL_MAX_LIFETIME_MS=1800000` (30 minutes) and restart the hub. Rotation is then due at **15 minutes** of instance age, so a runtime created just now waits 15 minutes; one that has already been up longer than that rotates on the next tick. Unset the variable afterwards — leaving it on makes every station restart every quarter of an hour and re-enrol each time.

#### Stop, Start, Destroy — what each one takes

Modal has no reversible stop, so these verbs do not mean quite what they mean on Docker.

| Action | Sandbox | Volume (`/workspace`) | Notes |
|---|---|---|---|
| **Stop** | terminated, permanently | untouched | The runtime keeps its identity and its files. Reaches `stopped` only once the driver polls Modal and confirms — never merely because the stop call returned. |
| **Start** | a **new** sandbox | re-attached by name | There is no start verb on Modal; the hub re-provisions against the same runtime id. New container, same workspace, same node id, rotated node secret. |
| **Destroy** | terminated | **deleted** | The only action that takes your work, and it is not recoverable. |

**Where the buttons are.** For a Modal runtime, use the **Runtimes** page (`/runtimes`). **Start** appears when the runtime is `stopped` or `error`; **Stop** appears when it is `online`; **Destroy** appears in every state but `provisioning` and `destroyed`. The Stop/Start buttons on a *node's* detail panel are Docker-only — a provisioned Modal node shows just **Destroy** there.

**A leaked Volume bills forever and the console cannot show it.** Destroy terminates the sandbox first and deletes the Volume second, and tolerates "already gone" on both — the 24-hour ceiling means the sandbox really is often gone already. Any *other* failure leaves the runtime un-destroyed with its external id intact, on purpose, so that retrying **Destroy** converges. If a destroy ever reports an error, retry it, and then check the Modal dashboard for a Volume named `agentpod-<runtime id>`. Once the runtime row is gone, nothing in AgentPod knows that Volume exists.

#### Credentials and RBAC

`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, from the Modal dashboard, in the hub environment.

**On Modal's Starter plan a token is workspace-wide.** Scoping a token per environment requires Modal's **Team plan (~$250/month)**. There is no way to engineer around this from the hub's side: on Starter, the hub's token can see and destroy everything in that Modal workspace. Use a Modal workspace dedicated to AgentPod and nothing else.

These tokens create infrastructure in a Modal workspace. They cannot reach an enrolled node — enrolment is outbound-dialled and SSH runs from your own machine.

#### The image

Modal pulls from a registry, runs **linux/amd64 only**, and requires **python and pip** in the image. Build it from `apps/node-agent/deploy/Dockerfile.modal` and set `NODE_AGENT_MODAL_IMAGE` to the pushed tag.

Three things are non-negotiable, each fatal on its own and each failing quietly:

1. **python3 and pip must be present.** The driver pulls the image and nothing else; Modal does not inject a python. Without it the sandbox never boots and the only symptom is a runtime stuck in `provisioning` until the sweeper expires it two minutes later.
2. **`ENTRYPOINT` must be empty.** Modal requires any image `ENTRYPOINT` to end in `exec "$@"` so its runtime can take over the command, and the fleet's entrypoint never can — it enrols and then execs its own run loop. `Dockerfile.modal` clears `ENTRYPOINT` and the driver passes `/modal-entrypoint.sh` as the sandbox **command** instead.
3. **linux/amd64 only.** On Apple Silicon the default build is arm64 and Modal rejects it — and the **base** must be amd64 too, or the build fails. `Dockerfile.modal` takes `ARG BASE_IMAGE` so you can build an amd64 base under its own tag instead of clobbering the arm64 `agentpod-node:base` your local Docker provisioner runs.

```bash
# amd64 base (Apple Silicon: this runs under emulation and is slow — wait it out)
docker buildx build --platform linux/amd64 \
  -f apps/node-agent/deploy/Dockerfile.base \
  -t agentpod-node:base-amd64 --load apps/node-agent

# the Modal layer, pushed to a PUBLIC repository
docker buildx build --platform linux/amd64 \
  --build-arg BASE_IMAGE=agentpod-node:base-amd64 \
  -f apps/node-agent/deploy/Dockerfile.modal \
  -t ghcr.io/<owner>/agentpod-node-modal:v0.1.0 --push apps/node-agent
```

**The repository must be public.** The driver calls Modal's `images.fromRegistry(tag)` with no Secret, so Modal has no credential to authenticate to a private registry with. A private tag passes the hub's boot check — it looks like a registry reference — and then fails at provision time.

These images are **hand-built and pushed by convention; there is no CI pipeline for any of them.** Do not infer one from the tag.

To sanity-check a built image before pushing, run its entrypoint test against a bind mount standing in for the Volume:

```bash
mkdir -p /tmp/fake-volume
docker run --rm --platform linux/amd64 \
  -v "$PWD/apps/node-agent/deploy":/t -v /tmp/fake-volume:/workspace \
  --entrypoint sh agentpod-node-modal:local /t/test-modal-entrypoint.sh
```

#### When a Modal runtime does not come up

- **Hub exits at startup naming a `MODAL_*` variable** — working as designed. Set the variable it names; the check is in `apps/hub/src/utils/validate-config.ts`.
- **Provision fails with "not a registry reference Modal can pull"** — the resolved image had no registry host. Most often this is a runtime created with the OpenCode or Pi harness while only `NODE_AGENT_MODAL_IMAGE` was set; set `NODE_AGENT_MODAL_OPENCODE_IMAGE` / `NODE_AGENT_MODAL_PI_IMAGE` too.
- **Stuck in `provisioning`, then `error` after two minutes** — the sandbox booted but never enrolled. Read the sandbox's logs in the Modal dashboard. The usual causes are an image without python, an arm64 image, and a `PROVISIONING_HUB_URL` the sandbox cannot reach.
- **`[modal] WARNING: /workspace does not look like a mounted Volume`** in the sandbox log — work written there will be lost at the next rotation. Do not use that station.
- **Every Modal runtime reports trouble at once** — suspect the credentials, not the fleet. An expired `MODAL_TOKEN_SECRET` fails every call. The driver deliberately refuses to translate an unreachable substrate into `stopped`, so this surfaces as `error`, loudly, rather than as a fleet that has quietly gone quiet.

---

## 5. Cmd-K palette

The command palette (keyboard shortcut: `Cmd-K` / `Ctrl-K`) provides quick access to:

- Navigate to a node or station by name
- Start / stop / restart a station
- New runtime (provision)
- Activity log

---

## 6. Activity ticker

The activity ticker (bottom of the console) shows a live feed of recent operations across the fleet: file writes, terminal sessions opened, lifecycle events, config edits. Click any entry to jump to the relevant station.

---

## 7. Matrix identity

Hermes stations that have a Matrix identity configured display the **Matrix ID** and a `matrix.to` deep-link in the station detail panel, so you can open a conversation with that agent identity directly from the console.

---

## 8. Troubleshooting

**Node not appearing online after enroll:**
- Check `apn logs -f` on the host for connection errors.
- Confirm `PROVISIONING_HUB_URL` or `--hub` URL is reachable from the host (not `127.0.0.1`).
- Check the hub log: `journalctl -u agentpod-hub -n 50 --no-pager`.

**Terminal disconnects and does not reconnect:**
- The node-agent holds the PTY master; a node-agent restart will lose unattached sessions.
- Ensure `agentpod-node` is running (`apn status`).

**Provisioned container does not auto-enroll:**
- Confirm `PROVISIONING_HUB_URL` is set to the container-reachable hub URL (not `127.0.0.1`).
- Check `ENABLE_DOCKER_PROVISIONING=true` in `/etc/agentpod/hub.env`.
- Check hub log for `"Provisioners registered: docker…"` on startup.

**Hub startup fails with migration error:**
- Confirm `DATABASE_URL` is correct and Postgres is running: `systemctl status postgresql`.
- Run migrations manually: `cd /opt/agentpod/apps/hub && bun run db:migrate`.
