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

### Fly Machines provisioner

Rents a machine per runtime from [Fly.io](https://fly.io). Available in the UI if
`ENABLE_FLY_PROVISIONING=true` and `FLY_API_TOKEN` are set in the hub env; the
hub refuses to boot with the flag on and no token. Env vars and their traps are
in [docs/DEPLOYMENT.md](./DEPLOYMENT.md#fly-machines-settings).

Unlike Cloudflare, **all three resource tiers work and the harness image is
honoured per machine** — Fly takes `config.guest` and `config.image` on each
machine create, so nothing is frozen at deploy time.

**What the hub creates per runtime**, in this order:

1. A Fly **app**, named `<FLY_APP_PREFIX>-<runtime id>` with underscores
   hyphenated — `rt_3f2a…` becomes `agentpod-rt-3f2a…`. Each gets its own 6PN
   `network`, so one runtime's machine cannot reach another's over Fly's private
   network.
2. A **volume** in it, always named `agentpod_data` (Fly volume names take
   underscores, not hyphens), sized by `FLY_VOLUME_SIZE_GB`, in `FLY_REGION`.
3. A **machine** mounting that volume at `/data`.

The order is not stylistic: a Fly volume is pinned to one physical host, and a
machine created before its volume can be placed on a different host and fail to
attach.

**Destroy deletes the app**, which takes the machine and the volume with it in
one call. That is the reason each runtime gets an app to itself — three ordered
deletes would be three places to fail half-way, and the resource most likely to
be left behind is the one that bills.

#### Cost — read this before enabling

**Fly has no free tier.** (Organisations still on the deprecated Hobby/Launch/
Scale plans keep a legacy allowance — 3 shared-cpu-1x 256 MB VMs and 3 GB of
volume. Those are the same accounts that hit the `FLY_REGION` refusal in
Troubleshooting below.)

Per runtime, for as long as its **app** exists:

| Resource | Bills while |
|---|---|
| Machine compute (CPU + RAM) | the machine is `started` — per second |
| Machine rootfs | the machine is `stopped` (while started it is covered by the compute rate) |
| Volume (`FLY_VOLUME_SIZE_GB`) | the app exists, whether or not any machine runs |

So **`stopped` on Fly does not mean "costing nothing".** Stopping a runtime
stops the compute — the largest line for a running station — and nothing else.
The volume that makes this substrate worth using is the same volume that keeps
billing. **`destroy` is what stops the bill**, because it deletes the app.

Rates from Fly's pricing page, checked 2026-08-13 (against the published page,
not against an invoice — treat them as order-of-magnitude and confirm on your
own bill):

- `shared-cpu-1x` **started**: ~$5.70/mo at 1 GB (tier `small`), ~$10.70 at 2 GB
  (`medium`), ~$21.40 at 4 GB (`large`), region-dependent, charged per second.
- **Volume**: $0.15/GB/month of provisioned capacity — so the default 3 GB is
  about **$0.45/month per runtime, running or stopped**.
- **Stopped rootfs**: $0.15 per GB per 30 days — so it depends on how large the
  harness image is, a dollar-fraction rather than a dollar.

A stopped runtime is therefore **under a dollar a month, indefinitely**, and a
**leaked app** — one whose hub row went away without a successful destroy —
bills that forever with nothing in the console to say it exists. `flyctl apps
list` is the only backstop. The driver already covers the one case it can see: a
`provision` that fails after creating the app deletes the app itself rather than
leaving an orphan the hub never learns the name of.

#### Why a Fly station is not reaped while idle

**The machine is created with no `services` block, and that is load-bearing.**

Fly's autostop is driven by Fly Proxy, and the proxy only reaches machines that
publish inbound `services`. A node-agent dials *out* to the hub and receives
nothing inbound, so any idle timer fed by inbound traffic reads a station in
heavy use as idle. That is not hypothetical: on 2026-08-12 a Cloudflare station
idled out 15 minutes after start, mid-session, and destroyed a file its user had
created four minutes earlier. Measured on Fly the same day: a machine with no
`services`, left idle for 25 minutes with only outbound traffic and sampled every
5 minutes, was `started` at every sample. The hub drives stop and start itself,
as it already does for every other provider.

> **Maintainers: do not add a `services` block to `fly.ts`.** It is the single
> change that would reintroduce the Cloudflare failure on the substrate chosen to
> avoid it, and it would look entirely reasonable in a diff — inbound HTTP to a
> station (a preview URL, a webhook receiver) is a plausible future feature, and
> `services` is how you get it. Adding one re-arms Fly's autostop against a
> workload that by design receives no inbound traffic. `fly.test.ts` pins the
> absence ("NEVER defines a services block"), so the test failure is the warning;
> this paragraph is why deleting the test is not the fix.

#### Why the workspace survives a stop

The Fly **rootfs is wiped on every stop→start** — measured 2026-08-12: a sentinel
written to `/` was gone after a stop→start, while the same sentinel on the
mounted volume was still there, byte-identical, with the machine id and the
volume both preserved.

So nothing that must outlive a stop lives on the rootfs. The image's wrapper
(`fly/node-image/volume-workspace.sh`) symlinks `/workspace` onto the volume and
points `$HOME` there before the harness entrypoint runs, so a restarted station
comes back with its files, its opencode session history **and its node identity**
(`agentpod-node` keeps `nodeId`/`nodeSecret` under `$HOME`). Fly's
`persist_rootfs` is deliberately not used — Fly's own docs disclaim it for
critical data. See `fly/node-image/README.md`.

If the volume fails to mount, the wrapper **exits non-zero rather than running**,
which with Fly's `restart.policy = "always"` is a visible crash loop. That is
deliberate: the alternative is a station that looks healthy while writing the
user's work to a filesystem that is about to be erased.

#### Known wrong number: workspace size on the Health panel

**A Fly station's Health panel reports a workspace of a few bytes.** The number
is wrong; nothing is missing.

The node-agent's disk-usage probe walks the station's workspace with Go's
`filepath.WalkDir`, which does not follow symlinks — and on Fly the workspace
root *is* the symlink `/workspace → /data/workspace`, so the walk measures the
link itself and stops. Every other workspace operation (Files, Terminal, `cd`,
Cleanup) follows the link normally, and the bytes are on the volume where they
belong.

It is not fixed because fixing it means changing node-agent Go — teaching
`refreshDiskUsage` to resolve its root through `filepath.EvalSymlinks` — which is
a fleet-wide binary change and a release, to correct one cosmetic figure on one
substrate. Worth doing eventually; not worth coupling to the Fly driver shipping.

#### Cross-checking against Fly directly

```bash
flyctl apps list                              # one app per runtime, prefixed agentpod-
flyctl machines list -a agentpod-rt-<id>      # state, region, image, machine id
flyctl volumes list -a agentpod-rt-<id>       # the volume holding the workspace
flyctl logs -a agentpod-rt-<id>               # the machine's console
```

A healthy boot logs `[fly] workspace and home anchored on /data`.

The money audit is `flyctl apps list`: **anything prefixed `agentpod-` that the
console does not show as a runtime is leaking.** Destroy it with
`flyctl apps destroy <app> --yes`.

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

**Hub refuses to boot naming `FLY_API_TOKEN`:**
- `❌ CONFIGURATION VALIDATION FAILED` with `FLY_API_TOKEN` means `ENABLE_FLY_PROVISIONING=true` with no token. That is deliberate, not a bug — the alternative is a hub that boots, offers Fly in the New Runtime dialog, and fails on a user's first provision.
- The token must be **org-scoped** (`flyctl tokens create org <org> --expiry 720h`). App-scoped deploy tokens cannot create apps, and this driver creates one per runtime.
- Strip the `FlyV1 ` prefix flyctl prints. Fly was measured on 2026-08-13 to accept the doubled prefix, so this will not fail loudly — it is just wrong.

**A Fly runtime never comes online:**
- `flyctl logs -a agentpod-rt-<id>`. `[fly] FATAL: /data is not mounted.` means the volume did not attach — check `flyctl volumes list -a <app>`. The wrapper refuses to run rather than write the workspace to a rootfs Fly wipes on the next stop.
- `exec format error` means an arm64 image. Rebuild with `--platform linux/amd64` (see `fly/node-image/README.md`).
- A pull failure means `NODE_AGENT_OPENCODE_IMAGE` is a bare local tag such as `agentpod-node-opencode:local`, or the registry package is private. Fly pulls anonymously from a registry and has no access to your Docker host.
- The machine can be `started` and the runtime still not online: the node-agent has to reach the hub *from Fly*, so `PROVISIONING_HUB_URL` must be a public URL, never `127.0.0.1`.

**Provisioning fails with "legacy or non-paid plan":**
- `FLY_REGION` names a region this account's plan does not cover. Measured 2026-08-12: `bom` refused, `sin` accepted, same account, same token. Set `FLY_REGION` to a region the plan allows or upgrade the Fly organisation.

**Provisioning fails with an app-creation error:**
- The token is app-scoped. This driver creates one app per runtime, which needs an org-scoped token: `flyctl tokens create org <org>`.

**A Fly station's Health panel shows a near-empty workspace:**
- Expected, and the files are fine — see [Known wrong number](#known-wrong-number-workspace-size-on-the-health-panel) above. Confirm with the Files tab or `ls -la /workspace` in the Terminal.

**A Fly runtime is `stopped` but still billing:**
- Also expected. A stopped Fly machine still bills its rootfs, and the volume bills for as long as the **app** exists. Only **Destroy** ends the charge. `flyctl apps list` shows what is still there.

**Hub startup fails with migration error:**
- Confirm `DATABASE_URL` is correct and Postgres is running: `systemctl status postgresql`.
- Run migrations manually: `cd /opt/agentpod/apps/hub && bun run db:migrate`.
