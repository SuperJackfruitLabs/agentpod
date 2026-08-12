# agentpod-sandbox-v2

The Cloudflare substrate for AgentPod stations. Replaces `../worker/`, which is
dead — see its `DEAD.md`.

A container runs a **released** `agentpod-node`, verified against `SHA256SUMS`
exactly as `install.sh` and self-update do, so a Cloudflare station runs the same
binary as the rest of the fleet. It dials the hub outbound and enrols itself; the
hub driver only does lifecycle.

## Stations sleep

`onActivityExpired` stops the container and Cloudflare stops charging — roughly
**12× cheaper** than staying alive (~$2/month per idle station against ~$28).

Cloudflare's activity timer is fed by *incoming* requests
([containers#147](https://github.com/cloudflare/containers/issues/147)), and a
node-agent receives none, so a station would always idle out eventually — 15
minutes after **start**, however hard it was being used.

> **This section used to say that was "fine, because a woken container re-enrols
> and resumes the same `nodeId`". That was wrong, and it cost a user their
> work.** Identity is not state: Cloudflare disk is ephemeral, so a woken station
> came back as the same station with an *empty workspace*, which is worse than an
> obvious failure because it looks like it survived. On 2026-08-12 a station
> slept exactly 15 minutes after start, mid-session, and destroyed a file its
> user had created four minutes earlier.

Two mechanisms now make sleeping safe rather than destructive:

- **The workspace is archived to R2** on SIGTERM and restored on start
  (`snapshot-wrapper.sh`). Cloudflare allows 15 minutes before SIGKILL, so there
  is ample room to archive a real workspace.
- **The hub renews the idle deadline** via `POST /sandbox/:id/touch` whenever it
  routes a verb to the station, so a station in use does not sleep at all.

Since Cloudflare sleeps on its own timer, the container **tells the hub** via
`POST /public/runtimes/:id/state` — otherwise the hub sees only a node that
stopped heartbeating and cannot tell "idled out" from "died".

## Routes

All except `/health` require `Authorization: Bearer $AGENTPOD_WORKER_TOKEN`.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness. Unauthenticated so the driver can fail fast on a bad URL without holding a credential. |
| `POST /sandbox` | Start a station. Body: `id`, `hubUrl`, `enrollToken`, `callbackToken`. |
| `GET /sandbox/:id` | Existence check. |
| `DELETE /sandbox/:id` | Destroy. |
| `POST /sandbox/:id/start` | Start — **also the wake path**. |
| `POST /sandbox/:id/stop` | Stop. |
| `POST /sandbox/:id/touch` | Renew the idle deadline. Called by the hub on station activity. |
| `GET`/`PUT /sandbox/:id/snapshot` | Restore / archive the workspace. **Per-sandbox token, not the admin token** — see below. |

The snapshot routes are the only ones not gated by `AGENTPOD_WORKER_TOKEN`. A
container must be able to save its own workspace without holding a credential
that could create or destroy sandboxes across the fleet, so it gets a token
minted per sandbox and stored in Durable Object storage. That token buys exactly
two things: read and write of its own archive. It cannot reach another station's
archive, and it cannot delete even its own — deletion happens only on the
admin-authenticated destroy path, so a compromised harness cannot erase the
user's work.

## Deploy

```bash
npm install
# Workspace archives. Without this bucket the worker will not deploy, which is
# deliberate — a deploy that silently lost workspaces is what this replaces.
npx wrangler r2 bucket create agentpod-snapshots
npx wrangler deploy
npx wrangler secret put AGENTPOD_WORKER_TOKEN   # openssl rand -hex 32
```

Then on the hub, in `/etc/agentpod/hub.env`:

```
ENABLE_CLOUDFLARE_SANDBOXES=true
CLOUDFLARE_WORKER_URL=https://<worker-url>
CLOUDFLARE_WORKER_TOKEN=<the same secret>
CLOUDFLARE_SANDBOX_IMAGE=<what imageForHarness returns for the harness you provision>
RUNTIME_CALLBACK_TOKEN=<shared secret for the sleep callback>
CLOUDFLARE_INSTANCE_TIER=large   # the tier this worker's instance_type provides
```

`CLOUDFLARE_INSTANCE_TIER` must match the `instance_type` in `wrangler.toml`
(`standard-1` is 4 GiB, which is the Docker `large` tier). Cloudflare fixes the
instance type per container class, so the driver **refuses** any other tier
rather than quietly handing out a size nobody asked for. Provisioning a
`small` Cloudflare station therefore fails by design until per-tier container
classes exist.

`CLOUDFLARE_SANDBOX_IMAGE` must match, because Cloudflare bakes the image at
deploy time and the driver **refuses** a mismatched spec rather than silently
ignoring it.

Changing `AGENTPOD_VERSION` in the Dockerfile means redeploying the worker — the
image is not selectable per request.
