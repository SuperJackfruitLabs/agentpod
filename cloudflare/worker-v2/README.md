# agentpod-sandbox-v2

The Cloudflare substrate for AgentPod stations. Replaces `../worker/`, which is
dead — see its `DEAD.md`.

A container runs a **released** `agentpod-node` plus the **OpenCode harness**,
mirroring `apps/node-agent/deploy/Dockerfile.opencode`. The binary is verified
against `SHA256SUMS` exactly as `install.sh` and self-update do, so a Cloudflare
station runs the same binary as the rest of the fleet. It dials the hub outbound
and enrols itself; the hub driver only does lifecycle.

`entrypoint.sh` is a **byte-identical copy** of `node-opencode-entrypoint.sh`,
enforced by `test/entrypoint-parity.test.ts`. That script double-forks to avoid a
zombie that freezes the health check and uses a sentinel so lifecycle `Stop` is
not undone by the supervision loop — both fixes for live-fleet bugs. Change the
original and copy it across; do not edit this one alone.

## Stations sleep

`onActivityExpired` stops the container and Cloudflare stops charging — roughly
**12× cheaper** than staying alive (~$2/month per idle station against ~$28).

Cloudflare's activity timer is fed by *incoming* requests
([containers#147](https://github.com/cloudflare/containers/issues/147)), and a
node-agent receives none, so a station always idles out eventually. That is fine
because a woken container re-enrols and **resumes the same `nodeId`** (runtime
identity persistence, #245). Before that landed, sleeping lost the station.

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

## Deploy

```bash
npm install
npx wrangler deploy
npx wrangler secret put AGENTPOD_WORKER_TOKEN   # openssl rand -hex 32
```

Then on the hub, in `/etc/agentpod/hub.env`:

```
ENABLE_CLOUDFLARE_SANDBOXES=true
CLOUDFLARE_WORKER_URL=https://<worker-url>
CLOUDFLARE_WORKER_TOKEN=<the same secret>
CLOUDFLARE_SANDBOX_IMAGE=agentpod-node-opencode:local
RUNTIME_CALLBACK_TOKEN=<shared secret for the sleep callback>
```

`CLOUDFLARE_SANDBOX_IMAGE` must match what `imageForHarness` returns for the
harness you provision — `agentpod-node-opencode:local` for `opencode`. Cloudflare
bakes the image at deploy time, and the driver **refuses** a mismatched spec
rather than silently ignoring it.

Changing `AGENTPOD_VERSION` in the Dockerfile means redeploying the worker — the
image is not selectable per request.
