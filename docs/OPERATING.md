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

**Rootless** — for key-only hosts where the login user has no `sudo` password. Pass `--user`; it installs into `~/.local/bin`, enrolls as you, and (if a user systemd manager is available) sets up a `systemd --user` service, otherwise prints run instructions (`apn run` / `tmux`):

```bash
curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh \
  | bash -s -- --user https://hub.<your-domain> <enrollment-token-from-console>
```
(If not root and `sudo` is absent, the installer auto-falls back to this rootless mode. For a `systemd --user` service to survive logout/reboot, run `sudo loginctl enable-linger <user>` once.)

**macOS** — the same one-liner (with or without `sudo`/`--user`) always installs rootless: binary in `~/.local/bin`, enrolled as the invoking user, service registered as a per-user LaunchAgent (`~/Library/LaunchAgents/dev.agentpod.node.plist`, label `dev.agentpod.node`). The `curl | sudo bash` form above re-execs itself as `$SUDO_USER` automatically, piped invocation included.

```bash
launchctl print gui/$(id -u)/dev.agentpod.node | head -20                        # status
tail -f ~/Library/Logs/agentpod-node.log                                         # logs
launchctl kickstart -k gui/$(id -u)/dev.agentpod.node                            # restart
launchctl bootout gui/$(id -u)/dev.agentpod.node && rm ~/Library/LaunchAgents/dev.agentpod.node.plist   # uninstall
```

A LaunchAgent only runs while you're logged in — system sleep suspends it, and the node shows offline until wake (by design).

The installer downloads the prebuilt binary for your platform (linux/darwin × amd64/arm64) from the latest GitHub Release, then — for a **system-wide Linux install (root, no `--user`)**:
1. Installs it to `/usr/local/bin/agentpod-node`.
2. Runs `agentpod-node enroll --hub <HUB_URL> --token <TOKEN>` — writes config to `/root/.config/agentpod-node/config.json`.
3. Installs and enables the systemd unit `agentpod-node.service`.

(Rootless and macOS installs use the different paths and service mechanism described above instead.)

The installer is idempotent: re-running upgrades the binary and re-enrolls. Binaries are published on every `v*` tag by `.github/workflows/release-node-agent.yml`.

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
# Or, install the systemd unit and let systemd manage it:
#   cp apps/node-agent/deploy/agentpod-node.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now agentpod-node
```

### Verify enrollment

```bash
systemctl status agentpod-node
journalctl -u agentpod-node -f
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
| **Claude Code** | Detected as leaf workspaces (project dirs containing `.claude/`) |
| **Codex** | Detected as leaf workspaces (project dirs with `~/.codex/` config) |
| **OpenCode** | Detected via running process or workspace markers |

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
- Check `journalctl -u agentpod-node -f` on the host for connection errors.
- Confirm `PROVISIONING_HUB_URL` or `--hub` URL is reachable from the host (not `127.0.0.1`).
- Check the hub log: `journalctl -u agentpod-hub -n 50 --no-pager`.

**Terminal disconnects and does not reconnect:**
- The node-agent holds the PTY master; a node-agent restart will lose unattached sessions.
- Ensure `agentpod-node` is running (`systemctl status agentpod-node`).

**Provisioned container does not auto-enroll:**
- Confirm `PROVISIONING_HUB_URL` is set to the container-reachable hub URL (not `127.0.0.1`).
- Check `ENABLE_DOCKER_PROVISIONING=true` in `/etc/agentpod/hub.env`.
- Check hub log for `"Provisioners registered: docker…"` on startup.

**Hub startup fails with migration error:**
- Confirm `DATABASE_URL` is correct and Postgres is running: `systemctl status postgresql`.
- Run migrations manually: `cd /opt/agentpod/apps/hub && bun run db:migrate`.
