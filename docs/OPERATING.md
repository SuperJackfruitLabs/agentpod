# AgentPod — Operator Guide

Day-2 operations: enrolling nodes, adopting stations, driving capability panels, and provisioning runtimes.

> **Single-operator note.** AgentPod targets one admin account. The first user to sign up becomes admin; signup is automatically disabled after that (`system_settings`).

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
# Expected: "connecting to https://hub.<your-domain> as <nodeId>"
#   (cmd/agentpod-node/run.go — this is the only line the agent prints at connect time)
```

In the console, navigate to **Nodes** — the enrolled host should appear with status **online**.

### Generating enrollment tokens

On the console's **Fleet** page (`/`), the header carries **Create enrollment token**; the
Cmd-K palette reaches the same thing via `/nodes?action=create-token`. Tokens are
single-use (`enrollment_tokens.used_at`) and scoped to the operator account
(`enrollment_tokens.user_id`).

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
| **Pi** | Workspace dirs under `~/.pi/agent/sessions/`, plus `/workspace` when it exists (the path Fly and Modal images mount) |

Every descriptor lives in `apps/node-agent/internal/descriptor/` and each one's discovery
paths are in its file header. That is the place to check when this table and a host disagree.

---

## 3. Drive a station

Click a station to open its capability panels. Available panels depend on which capabilities the harness descriptor advertises for that station. The capability vocabulary is
`Capability` in `packages/contract/src/station.ts`: `inventory`, `health`, `logs`,
`fs.read`, `fs.write`, `terminal`, `lifecycle`, `cleanup`, `acp`, `changeset`. Which of
those a given harness advertises is the `caps := []string{…}` literal in its descriptor —
`lifecycle` only for Hermes and OpenClaw, `acp` only when the whole chat chain resolves.

### Health

Shows the fields of `StationHealth` (`packages/contract/src/station.ts`): running · pid ·
CPU % · memory bytes · disk bytes · uptime · last activity · a free-text note. Refreshes
automatically; click the refresh icon to force a poll.

### Logs

Live-tailing log stream from the runtime. The descriptor uses the harness's native log source (e.g. `hermes logs`, `~/.openclaw/logs/`, process stdout).

- **Tail** — streams new lines as they arrive.
- **History** — scrolls back through buffered lines.
- Logs are streamed over the node tunnel as framed messages; no polling.

### Terminal

An interactive PTY shell **started in** the station's workspace root. The node-agent keeps
the session alive across console/network disconnects (`internal/terminal`) — reconnecting
re-attaches the existing session with its running command and scrollback intact.

> **The shell is not confined.** It is the host user's `$SHELL` with `cmd.Dir` set to the
> workspace (`internal/terminal/session.go`); the `safeJoin` containment used by the
> filesystem verbs is not applied to the PTY, and `cd ..` works. Anyone you give a Terminal
> tab has that node-agent user's full access to the host. This paragraph used to promise a
> path jail that has never existed — treat the Terminal capability as shell access, and
> scope who can reach a station accordingly.

### Files

A file browser for the station's workspace. The write verbs are exactly the four routes in
`apps/hub/src/routes/station-writes.ts`: `fs/write`, `fs/mkdir`, `fs/move`, `fs/delete`
(plus read/list over the read path). **There is no upload and no download.**

Every write is recorded in the station's audit log (`station_audit`), which the console
shows as the station's Activity tab — not the fleet-wide `/activity` feed.

### Config

Read and edit the station's known config files (e.g. `~/.hermes/config.yaml`,
`~/.openclaw/openclaw.json`, `.claude/settings.json`). A write goes through the ordinary
`fs/write` verb with `backup: true`, so the node keeps a timestamped copy beside the file
and the console shows a diff before you commit the change.

> Two things this panel does **not** do, despite having claimed both for a long time: there
> is no clobber detection (a file changed on the host since you opened it is overwritten
> without a word), and there is no Restore button — the backup path is printed as text and
> restoring it is a manual step on the node. No descriptor advertises a `config` capability
> either; the panel is gated on `fs.read`/`fs.write` like the file browser.

### Lifecycle

Start / stop / restart the station's runtime. Behaviour is harness-specific:

Only Hermes and OpenClaw advertise `lifecycle`; on every other harness the panel does not
appear at all.

| Harness | Lifecycle mechanism |
|---------|-------------------|
| Hermes | Per-profile process, started **detached** as `hermes -p <name> gateway run --replace` — via `systemd-run --collect --quiet` where available, precisely so it escapes the node-agent's own cgroup and survives `apn restart` (`internal/descriptor/hermes.go`) |
| OpenClaw | User systemd unit (`openclaw-gateway.service`) |
| Claude Code / Codex / OpenCode / Pi | No persistent process — `lifecycle` is never advertised, so there is no panel |

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

Available in the UI if `ENABLE_CLOUDFLARE_SANDBOXES=true` is set in the hub env. Status: **live-unverified** — use Docker for production provisioning.

### Modal provisioner

Available in the **New runtime** provider list if `ENABLE_MODAL_PROVISIONING=true` is set in the hub env. Configuration: see the `── Provisioning ──` block in `docs/DEPLOYMENT.md`.

#### Cost, before anything else

Modal **Sandboxes** carry roughly a **3× premium over standard Modal compute**, and they bill **wall-clock for as long as the sandbox exists** — not CPU burned. A sandbox sitting at 0% CPU waiting for its operator costs the same as one working flat out. A minimal always-on runtime is about **$21/month**; **Volumes bill separately**, on stored bytes, and keep billing until they are deleted.

A mostly-idle fleet is therefore Modal's worst case, and AgentPod fleets are mostly idle. Modal earns its place for short, bursty, isolated work — a runtime you create, use, and destroy the same day. For a long-lived station that sits waiting for someone to open a terminal, Docker is cheaper by a wide margin and Cloudflare sleeps when idle where Modal does not.

> Pricing figures are Modal's published rates read on **2026-08-13**. Re-check them before turning this on; nothing in the hub reads Modal's price list, and nothing here will tell you if it moves.

#### What a Modal runtime actually is

**A rolling series of disposable sandboxes anchored by one named Volume.** The Volume is named `agentpod-<slugged runtime id>` — `volumeNameFor` lowercases the id, replaces every character outside `[a-z0-9-]` with `-` and truncates to 50 characters, so `rt_3f2a…` becomes `agentpod-rt-3f2a…`, **not** `agentpod-rt_3f2a…`. It holds the workspace at `/workspace` and outlives every sandbox. The sandbox is disposable and always will be.

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

**A leaked Volume bills forever and the console cannot show it.** Destroy terminates the sandbox first and deletes the Volume second, and tolerates "already gone" on both — the 24-hour ceiling means the sandbox really is often gone already. Any *other* failure leaves the runtime un-destroyed with its external id intact, on purpose, so that retrying **Destroy** converges. If a destroy ever reports an error, retry it, and then check the Modal dashboard for a Volume named `agentpod-<slugged runtime id>` — the underscore in `rt_…` is a hyphen in the Volume name, so search for `agentpod-rt-`. Once the runtime row is gone, nothing in AgentPod knows that Volume exists.

#### Credentials and RBAC

`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, from the Modal dashboard, in the hub environment.

**On Modal's Starter plan a token is workspace-wide.** Scoping a token per environment requires Modal's **Team plan (~$250/month)**. There is no way to engineer around this from the hub's side: on Starter, the hub's token can see and destroy everything in that Modal workspace. Use a Modal workspace dedicated to AgentPod and nothing else.

These tokens create infrastructure in a Modal workspace. They cannot reach an enrolled node — enrolment is outbound-dialled and SSH runs from your own machine.

#### The images — one per harness

Modal pulls from a registry, runs **linux/amd64 only**, and requires **python and pip** in the image. There are **three**, because the console offers three harnesses for every provider and each needs its own image:

| Harness | Dockerfile (context `apps/node-agent`) | Published image | Hub variable |
|---|---|---|---|
| Generic | `deploy/Dockerfile.modal` | `agentpod-node-modal` | `NODE_AGENT_MODAL_IMAGE` |
| OpenCode | `deploy/Dockerfile.modal.opencode` | `agentpod-node-modal-opencode` | `NODE_AGENT_MODAL_OPENCODE_IMAGE` |
| Pi | `deploy/Dockerfile.modal.pi` | `agentpod-node-modal-pi` | `NODE_AGENT_MODAL_PI_IMAGE` |

**The hub refuses to boot if any of the three is missing** (issue #283 — before that check, a Modal hub booted clean and answered 502 the first time anyone picked OpenCode or Pi). The harness images are built `FROM` the ordinary harness images, so the opencode/pi version pins live in `Dockerfile.opencode` / `Dockerfile.pi` only.

The OpenCode image sets `AGENTPOD_INNER_ENTRYPOINT=/node-opencode-entrypoint.sh`: Modal starts every image with the same command, so an image whose harness needs a supervision loop has to say so itself. **Known cost:** on Modal, `$HOME` stays on the disposable rootfs (the Volume must never hold node credentials), so an OpenCode station on Modal keeps its *files* across the 24-hour rotation and loses its *conversation history*. Fly, whose `$HOME` is on the volume, keeps both.

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
  -t ghcr.io/<owner>/agentpod-node-modal:<release> --push apps/node-agent
```

**The repository must be public.** The driver calls Modal's `images.fromRegistry(tag)` with no Secret, so Modal has no credential to authenticate to a private registry with. A private tag passes the hub's boot check — it looks like a registry reference — and then fails at provision time.

**Prefer the CI pipeline over the hand-build above.** `.github/workflows/publish-images.yml` (Actions → publish-images → Run workflow, choose `all` or one of `fly`, `fly-pi`, `modal`, `modal-opencode`, `modal-pi`, and a tag) builds natively on an amd64 runner, pushes to GHCR, and verifies what it published:

- every image — `agentpod-node version` runs;
- Modal images — `python3` and `pip` exist and `ENTRYPOINT` is empty;
- harness images — the harness binary is resolvable **from a minimal service PATH** with the image's own `ENV` discarded (`env -i PATH=/usr/local/sbin:…:/bin`), which is the shape of the environment the node-agent spawns an ACP adapter in;
- the harness-less image — no harness binary is present, so a "Generic" runtime does not quietly detect stations nobody asked for.

It also stamps the source commit as an image label, which a hand-built tag records nowhere. The commands above remain accurate for building locally when iterating on a Dockerfile.

**Which node-agent a Fly image carries is resolved by the workflow, not pinned in the repo.** The Fly images bake in a *released* binary (verified against `SHA256SUMS`) rather than compiling one the way the Modal images do, so they need a version — and the workflow resolves the latest release at build time, passes it as `--build-arg AGENTPOD_VERSION=…`, and then asserts the pushed image reports that version. A Fly publish therefore always ships the newest agent, with no Dockerfile edit to remember. Leave the optional `node_agent_version` input blank for that; set it only to publish an older release on purpose. The input and the check apply to `fly`/`fly-pi` only — a Modal-only publish never reads them. (Before this, both Fly Dockerfiles hardcoded `v0.1.22` while the fleet ran `v0.1.24`, so a merged node-agent fix could not reach a Fly station at all: issue #290. CI now fails when those `ARG` defaults — which is what a hand-build uses — fall behind the latest release.)

**You do not open the bump PR by hand.** Cutting a release runs `release-node-agent.yml`'s `fly-pin` job, which moves both `ARG` defaults onto the tag it just released and opens `chore/fly-pin-<tag>` against `main` for you; merge it and the guard is satisfied. It is a no-op when the pin is already there, and it refuses to move the pin onto a release whose linux binaries or `SHA256SUMS` never uploaded. If that PR's required checks sit at *Expected* rather than running, dispatch them: `gh workflow run ci.yml --ref chore/fly-pin-<tag>` (a PR opened by `GITHUB_TOKEN` cannot trigger `pull_request` workflows, so the job dispatches CI itself — this is the manual fallback if that dispatch failed).

To sanity-check a built image before pushing, run its entrypoint test against a bind mount standing in for the Volume:

```bash
mkdir -p /tmp/fake-volume
docker run --rm --platform linux/amd64 \
  -v "$PWD/apps/node-agent/deploy":/t -v /tmp/fake-volume:/workspace \
  --entrypoint sh agentpod-node-modal:local /t/test-modal-entrypoint.sh
```

#### When a Modal runtime does not come up

- **Hub exits at startup naming a `MODAL_*` variable** — working as designed. Set the variable it names; the check is in `apps/hub/src/utils/validate-config.ts`.
- **Provision fails with "not a registry reference Modal can pull"** — the resolved image had no registry host. This used to be the OpenCode/Pi case, and the hub now refuses to boot rather than letting a user find it; reaching it today means an image variable holds a registry-shaped tag that Modal still cannot pull (a private repository, or a typo in the host).
- **Stuck in `provisioning`, then `error` after two minutes** — the sandbox booted but never enrolled. Read the sandbox's logs in the Modal dashboard. The usual causes are an image without python, an arm64 image, and a `PROVISIONING_HUB_URL` the sandbox cannot reach.
- **`[modal] WARNING: /workspace does not look like a mounted Volume`** in the sandbox log — work written there will be lost at the next rotation. Do not use that station.
- **Every Modal runtime reports trouble at once** — suspect the credentials, not the fleet. An expired `MODAL_TOKEN_SECRET` fails every call. The driver deliberately refuses to translate an unreachable substrate into `stopped`, so this surfaces as `error`, loudly, rather than as a fleet that has quietly gone quiet.

### Fly Machines provisioner

Rents a machine per runtime from [Fly.io](https://fly.io). Available in the UI if
`ENABLE_FLY_PROVISIONING=true` and `FLY_API_TOKEN` are set in the hub env; the
hub refuses to boot with the flag on and no token. Env vars and their traps are
in [docs/DEPLOYMENT.md](./DEPLOYMENT.md#fly-machines-settings).

Unlike Cloudflare, **all three resource tiers work and the harness image is
honoured per machine** — Fly takes `config.guest` and `config.image` on each
machine create, so nothing is frozen at deploy time.

**Which harnesses Fly can actually run**, and it is not all of them:

| Harness | Dockerfile (context = repo root) | Published image | Hub variable |
|---|---|---|---|
| OpenCode | `fly/node-image/Dockerfile` | `agentpod-node-opencode-fly` | `NODE_AGENT_FLY_OPENCODE_IMAGE` |
| Pi | `fly/node-image/Dockerfile.pi` | `agentpod-node-pi-fly` | `NODE_AGENT_FLY_PI_IMAGE` |
| Generic | — none published — | — | `NODE_AGENT_FLY_IMAGE` |

The console offers **Generic** for Fly anyway, and it cannot work: there is no
image to pull. The hub reports that at boot — `⚠️ WARNING` naming
`NODE_AGENT_FLY_IMAGE` — rather than refusing to start, because refusing would
make Fly unbootable for the two harnesses that *do* work. Both Fly images take
the node-agent binary from a **release** (verified against `SHA256SUMS`) rather
than compiling it, and both are pinned to the same version on purpose.

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

- **Started machine**, region-dependent and charged per second. The tiers are not all
  `shared-cpu-1x` — `FLY_TIERS` in `services/provisioner/fly.ts` is
  `small` = 1 cpu / 1024 MB, `medium` = **2 cpus** / 2048 MB, `large` = **4 cpus** / 4096 MB,
  so the vCPU half of the bill doubles and quadruples with the tier. Roughly ~$5.70/mo for
  `small`; take `medium` and `large` from Fly's calculator with 2 and 4 shared vCPUs rather
  than from a `shared-cpu-1x` row.
  **The `opencode` harness needs `medium` or larger** — measured 2026-08-13, one
  chat turn peaks at 855 MB of harness on top of ~157 MB of OS and node-agent,
  which is the whole of a 1 GB machine (#279). The console no longer offers that
  combination and the hub refuses it with a 400; `small` stays right for a bare
  node (`harness: none`).
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

The command palette (`Cmd-K` / `Ctrl-K`) offers exactly four actions plus node navigation
— the full list is the `Command.Item` set in `apps/console/src/lib/components/command-palette.svelte`:

- **New runtime** → `/nodes?action=new-runtime`
- **Create enrollment token** → `/nodes?action=create-token`
- **Fleet** → `/`
- **Settings** → `/settings`
- a **Nodes** group: jump to a node by hostname

There are no station entries and no lifecycle verbs in the palette.

---

## 6. Activity feed

Fleet-wide activity lives on its own **`/activity`** page (`GET /api/activity`): file writes,
terminal sessions opened, lifecycle events, config edits. A single station's own audit trail
is on that station's Activity tab (`GET /api/stations/:id/activity`). There is no
always-visible ticker; the strip at the bottom of the console on narrow viewports is the
mobile navigation bar.

---

## 7. Matrix identity

Hermes stations that have a Matrix identity configured display the **Matrix ID** and a `matrix.to` deep-link in the station detail panel, so you can open a conversation with that agent identity directly from the console.

### 7a. The homeserver

`id.agentpod.dev` runs **tuwunel** (Apache-2.0), on the same host as the hub. It
replaced Synapse (AGPLv3) on 2026-08-16; see
`docs/superpowers/specs/2026-08-16-tuwunel-appservice-spike-findings.md` for why,
and what was verified before the switch.

| | |
|---|---|
| service | `tuwunel` (systemd → Docker, unit in `deploy/tuwunel/`) |
| listens | `127.0.0.1:6167`, never exposed directly; nginx proxies `/_matrix` |
| data | `/var/lib/tuwunel` (RocksDB, embedded — there is no separate database) |
| config | `/etc/tuwunel/tuwunel.toml` |
| appservice | `/etc/tuwunel/appservices/agentpod.yaml` — namespaces `@agent_.*`, `#agentpod_.*` |
| backups | `/var/backups/tuwunel`, nightly at 04:17 via `/etc/cron.d/tuwunel-backup` |

```sh
systemctl status tuwunel
journalctl -u tuwunel -f
curl -s localhost:6167/_matrix/client/versions      # is it serving?
```

**Two log lines that look like faults and are not.** `ERROR … loopback/localhost
listening address … will NOT work` is a false positive under `--network host`,
where 127.0.0.1 *is* the host. `Error response from daemon: No such container:
tuwunel` is the unit's `ExecStartPre=-docker rm -f`, which is why it carries a
`-`.

**Registration is closed** (`allow_registration = false`). Accounts are made
deliberately: the appservice registers agents inside its own namespace, and a
human needs the admin console.

### 7b. Admin commands

tuwunel has **no Synapse-style admin HTTP API**. Its admin surface is a room —
`!94p3O40IPw164WyxHc:id.agentpod.dev`, which `@rakesh` is a member of. Send
`!admin <command>` as an ordinary message:

```
!admin server help
!admin users list-users
!admin users create-user <name> [password]      # prints the password — see below
!admin server backup-database
```

**`create-user` echoes the generated password** into whatever ran it. If that is
a terminal or a transcript, follow with `!admin users reset-password <name>` and
keep only the second one.

When the server is stopped, the same commands run offline against the database
with `--execute`, which is how the first admin was made:

```sh
systemctl stop tuwunel
docker run --rm --network host -v /var/lib/tuwunel:/var/lib/tuwunel \
  -v /etc/tuwunel/tuwunel.toml:/etc/tuwunel/tuwunel.toml:ro \
  -e TUWUNEL_CONFIG=/etc/tuwunel/tuwunel.toml \
  ghcr.io/matrix-construct/tuwunel:latest --execute 'users make-user-admin <name>'
systemctl start tuwunel
```

Only one process may hold the RocksDB lock, which is why this needs the stop.

### 7c. Backups, and restoring one

`backup-database` writes a **RocksDB checkpoint while the server keeps running** —
consistent by construction, unlike copying live files. `database_backups_to_keep`
holds the last 3.

```sh
/usr/local/bin/tuwunel-backup.sh          # take one now
ls /var/backups/tuwunel/
```

Restoring is a startup flag: `--restore-backup [<id>]` restores before opening
the database, most recent when no id is given. `!admin server list-backups` lists
them.

> **Every path in `tuwunel.toml` must also be mounted in the unit.** The backup
> path was configured before it was mounted, and `backup-database` failed with
> "No such file or directory" for a directory that plainly existed on the host.

**Off-site is still an open gap.** The nightly backup is on the same disk as the
thing it protects. The Synapse-era archive was copied off manually
(`~/agentpod-backups/matrix-backup-2026-08-16.tar.gz`); nothing does that on a
schedule yet.

### 7d. The Matrix bridge

Every station gets a Matrix identity and a room, so an agent whose harness has
never spoken Matrix can be talked to from a phone. Design:
`docs/superpowers/specs/2026-08-16-matrix-application-service-design.md`.

| | |
|---|---|
| switch | `ENABLE_MATRIX_BRIDGE` — the **literal lowercase `true`**; `1`, `TRUE` and `yes` are off |
| config | `MATRIX_HOMESERVER_URL` (default `http://127.0.0.1:6167`), `MATRIX_SERVER_NAME`, `MATRIX_AS_TOKEN`, `MATRIX_HS_TOKEN` |
| a station's user | `@agent_<node>__<station>:id.agentpod.dev` — **two** underscores between the halves |
| its room | `#agentpod_<node>__<station>:id.agentpod.dev` |

**Finding an agent's room.** The names are derived from the node and the station
key, so `openclaw:krishna` on `superchotu` is
`#agentpod_superchotu__openclaw_krishna`. The member list shows the readable
form — `krishna (openclaw @ superchotu)`.

**Who may talk to an agent** is the control pair, unchanged. A refusal arrives
**in the room**, saying which of the three things happened: the hub does not
recognise the sender, the sender's grant does not cover that agent, or the
station could not be reached.

**Turning it off** is one field in the homeserver's registration file:

```yaml
url: null          # was http://127.0.0.1:3001
```

then `systemctl restart tuwunel`. The hub keeps running; the homeserver simply
stops pushing. This is also the state the bridge shipped in, which is why the
health check treats "no transaction has ever arrived" as **silent**, not healthy:
a registration with no `url` is a perfectly healthy Application Service
connected to nothing, and that went unnoticed for months.

**Two modes, and only ever one answerer.** A station is `bridge` (the
Application Service speaks for it — the default, and no credential exists
anywhere) or `harness` (it runs its own Matrix client). `POST
/api/stations/:id/matrix/credentials` issues a token and flips the mode in the
same write; it needs `mayGrantReach`, because handing an agent a credential is
granting it reach.

### 7e. What happened to the Synapse history

The old homeserver's 19,603 events are **not in tuwunel** — there is no supported
import path from Synapse into the Conduit lineage, and Matrix here carries a
projection rather than the truth (`acp_events` is the transcript of record). The
SQLite database, its signing key and the appservice registration are preserved in
`/root/matrix-backup-2026-08-16/` on the host and in
`~/agentpod-backups/` off it. To read that history, run a throwaway Synapse
against a *copy* — never against the original.

---

## 8. The kaambaan bridge

The bridge lets this hub **claim work from a kaambaan board** and run it on a station. It is
outbound-only: it adds no HTTP route, opens no port, and nothing about a hub with it off is
different from a hub built before it existed. See
[DEPLOYMENT.md → kaambaan bridge](./DEPLOYMENT.md#kaambaan-bridge) for the three variables
and how the hub refuses a bad roster at boot.

### Is it on?

The hub prints one line at boot, always, on or off:

```bash
journalctl -u agentpod-hub | grep 'kaambaan bridge:'
# kaambaan bridge: claiming as codex-mac, pi-vps
# kaambaan bridge: (disabled)
```

Then one `claiming` line per roster entry with its board, station, mode and base URL.

> **`ENABLE_KAAMBAAN_BRIDGE=1` does not turn it on.** `isBridgeEnabled()` compares against
> the literal lowercase string `"true"` — `1`, `TRUE` and `yes` all read as off. Boot
> validation uses the looser `getEnvBool`, so `=1` is the one value that passes validation
> *and* starts nothing; the boot line above is what tells you which happened.

### What the loop does, and how fast

None of these are configurable — they are constants in `services/bridge/`:

| Interval | Value | When |
|---|---|---|
| poll | 5s | after a cycle that found nothing to claim |
| backoff | 30s | after a thrown cycle, and after `not-ready` or `released` — claim/release/claim is not a fix |
| heartbeat | 60s | while a card is being worked (kaambaan reclaims an unheartbeated run at 15 min) |
| turn timeout | 30 min | one prompt turn; on expiry the run is failed on the board and the session ended |

**One status halts a loop permanently: `foreign-run`** (kaambaan answered 403 `NOT_RUN_OWNER`).
The agent stops claiming and only a hub restart resumes it — there is no route or metric that
reports this, so `grep 'halting: a run belonged to another agent'` in the hub log is the only
signal. A lost lease (409 `STALE_LEASE`) is *not* a halt; it is ordinary and the loop claims again.

### Reading `bridge_dispatches`

There is no API for the ledger — Postgres is the read path. One row per claimed run, keyed
`(external_source, external_run_id)`; `external_source` is always `kaambaan`.

| `outcome` | Means |
|---|---|
| `working` | claimed, nothing concluded yet. A re-claim of the same run updates the lease in place rather than adding a row |
| `produced` | **the work finished and the handoff is recorded, but the board has not been told.** This is the replayable state: the next claim of the same card reports the stored output without re-running the harness |
| `reported` | the board knows; nothing left to replay |
| `released` | the claim was handed back **before any ACP session opened**, so the workspace cannot have been touched. Unpenalised |
| `abandoned` | the run stopped *after* it started — a permission question that went unanswered, a turn timeout, a failure, or a release the board refused. The workspace may hold partial work, so nothing is replayed |

`released` vs `abandoned` is the distinction worth keeping straight: it is the only record of
whether a workspace was touched, and `acp_run_id` cannot carry it (that column is only written
once the first ACP event arrives).

Two id spaces meet in this table and must never be confused: `external_run_id` is kaambaan's
`run_…`, and `acp_run_id` is AgentPod's own `attempt_<uuid>` — one prompt-turn on a station,
minted locally. A claimed card takes as many attempts as the work takes. Both directions are
enforced in the database, not just in code: `acp_runs.id` must start `attempt_`, and both
tables refuse an `external_run_id` that starts `attempt_`.

Every row carries `tenant_id`, and every ledger read and write is built through
`tenantScope()`, which binds the tenant as the *first* predicate and refuses a tenant id that
is not AgentPod's own `fleet_<20 hex>` grammar — a kaambaan `tnt_…` cannot become a predicate
here. Today `resolveTenantForUser` returns the bootstrap tenant `fleet_00000000000000000000`
for everyone; the boundary is in place ahead of the mapping.

The two coalescing counters on each row, `events_received` and `activities_posted`, answer
"is the transcript being projected, and by how much" — the query and how to read a `NULL`
are under [Troubleshooting](#9-troubleshooting).

---

## 9. Troubleshooting

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
- A pull failure means the resolved image (`NODE_AGENT_FLY_OPENCODE_IMAGE` / `NODE_AGENT_FLY_PI_IMAGE`, else the un-scoped `NODE_AGENT_OPENCODE_IMAGE` / `NODE_AGENT_PI_IMAGE`) is a bare local tag such as `agentpod-node-opencode:local`, or the registry package is private. Fly pulls anonymously from a registry and has no access to your Docker host. The hub prints a `⚠️ WARNING` at boot for exactly this, per harness — check the startup log before assuming Fly is at fault.
- A runtime created with the **Generic** harness cannot come up at all: no harness-less Fly image is published. Create it as OpenCode or Pi.
- The machine can be `started` and the runtime still not online: the node-agent has to reach the hub *from Fly*, so `PROVISIONING_HUB_URL` must be a public URL, never `127.0.0.1`.

**Provisioning fails with "legacy or non-paid plan":**
- `FLY_REGION` names a region this account's plan does not cover. Measured 2026-08-12: `bom` refused, `sin` accepted, same account, same token. Set `FLY_REGION` to a region the plan allows or upgrade the Fly organisation.

**Provisioning fails with an app-creation error:**
- The token is app-scoped. This driver creates one app per runtime, which needs an org-scoped token: `flyctl tokens create org <org>`.

**A Fly station's Health panel shows a near-empty workspace:**
- Expected, and the files are fine — see [Known wrong number](#known-wrong-number-workspace-size-on-the-health-panel) above. Confirm with the Files tab or `ls -la /workspace` in the Terminal.

**A Fly runtime is `stopped` but still billing:**
- Also expected. A stopped Fly machine still bills its rootfs, and the volume bills for as long as the **app** exists. Only **Destroy** ends the charge. `flyctl apps list` shows what is still there.

**Is the kaambaan bridge's coalescing working, and by how much?**

The bridge projects a harness's ACP transcript into board activities, and it must not do so 1:1 — one trivial prompt was measured at 57 events from Codex and 1,051 from Hermes, so a harness that streams token by token would otherwise fire a thousand POSTs at a board for one instruction. Every dispatch records both ends of its own transcript, so the question is answerable from the hub alone:

```sql
SELECT external_run_id, external_card_id, outcome,
       events_received, activities_posted,
       round(events_received::numeric / nullif(activities_posted, 0), 1) AS events_per_activity
FROM bridge_dispatches
WHERE events_received IS NOT NULL
ORDER BY started_at DESC
LIMIT 20;
```

- **`events_per_activity` near 1** on a chatty harness means coalescing is not happening — the board is being posted to once per chunk.
- **`activities_posted = 0`** with a non-zero `events_received` means the whole transcript projected to nothing and the board saw silence. The hub log line for that run lists the event kinds that had no projection.
- **Both columns `NULL`** is not zero: nobody counted. The run never opened a session (a claim handed straight back, or a replay of a prior run's recorded output), or it predates this being measured at all.

The same two numbers appear once per worked card in the hub log — `journalctl -u agentpod-hub | grep 'coalesced the transcript'` — with the run, card, station and attempt ids. One line per card, never per event, and it carries no card content, prompt or harness output.

**A card on the board is sitting in `input-required`:**

The agent asked for permission and is waiting for a person. The question is on the card, with the options the harness offered; answering it in kaambaan moves the card back to `working` and the same run — which never let go of the card, and has been heartbeating the whole time — carries on with the answer.

- **Only a human can answer it.** kaambaan refuses an agent token on the answer route and separately refuses the asking agent's own identity, so no amount of hub configuration will make the bridge answer its own question.
- **The wait is bounded**, by `permissionWaitMs` on the agent's entry in `KAAMBAAN_BRIDGE_AGENTS` (default 30 minutes) — *not* by kaambaan's 15-minute reclaim, which never fires here because the run keeps heartbeating. When it runs out the run is failed with a reason naming the wait, the card is re-queued with a failure count, and the next attempt asks again. A card that keeps going unanswered eventually trips kaambaan's circuit breaker and parks for a human.
- **What gets asked depends on the mode.** `full-auto` never asks. `accept-edits` — the supervised setting — auto-approves file writes and asks about anything that executes. `ask` asks about every tool call, which is a great deal of asking; it is a mode for a board somebody is watching, not a default.
- `journalctl -u agentpod-hub | grep -E 'permission request'` shows both ends: `a human answered a permission request` with the option that was chosen, and `a permission request went unanswered` with the reason.

**Hub startup fails with migration error:**
- Confirm `DATABASE_URL` is correct and Postgres is running: `systemctl status postgresql`.
- Run migrations manually: `cd /opt/agentpod/apps/hub && bun run db:migrate`.
