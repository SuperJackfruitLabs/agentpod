# Cloudflare Sandbox driver — design

**Status:** approved 2026-08-12
**Horizon:** 1 — step 3 of the re-planned driver wave
**Depends on:** `2026-08-12-runtime-identity-persistence-design.md` (hard dependency)
**Revised 2026-08-12** — sleep/wake is **in scope**. See "Sleep and wake".
**Evidence:** `2026-08-12-cloudflare-sandbox-spike-findings.md`

## Problem

There is one substrate today — Docker on the hub box. Every provisioned runtime shares a
machine with the control plane, and the fleet has nowhere else to run.

Cloudflare gives a second substrate with real geographic reach and no machine to operate.
The existing driver and worker cannot deliver it: both are OpenCode-era and marked dead
(`cloudflare/worker/DEAD.md`). The worker has no `agentpod-node` in its image and discards
the `env` the driver sends, so a provision would return 2xx and produce a runtime that
never enrols.

## What the spike established

Verified against the production hub, then torn down:

| | |
|---|---|
| A Cloudflare container running `agentpod-node` **enrols and connects** | online in ~20s, `hostname=cloudchamber` |
| It **survives `sleepAfter`** | 9 minutes at a 2-minute timeout, one continuous process |
| **Because `onActivityExpired()` fires and the override renews the timer** | observed in the tail, exactly as documented |
| **Identity does not survive a restart** | container restarted cleanly, node never returned |
| **The wake path works** | `stop` then `start` reliably restarts the container |

So the substrate is viable. The single blocker is identity, which is why this spec depends
on the one above and must not ship before it.

## Design

### Sleep and wake

Stations **sleep when idle and wake on demand**. This was briefly scoped out on
the grounds that the spike showed sleep is not a *correctness* blocker — a
container can stay alive indefinitely by overriding `onActivityExpired()` without
stopping. That reasoning was wrong, because cost is the reason this substrate is
interesting at all:

| | Per station | × 39 |
|---|---|---|
| Always-on (4 GiB) | ~$28/mo | ~$1,090/mo |
| Sleeping when idle, awake ~2h/day | ~$2/mo | ~$90/mo |

Cloudflare stops charging once an instance sleeps. Roughly a **12× difference**,
which is the difference between a viable second substrate and an expensive one.

**Identity persistence is what makes this possible now.** The original blocker was
never the sleeping — it was that a woken container came back as a *different
node*. With runtime-bound re-enrolment merged, a woken container re-enrols and
resumes the **same `nodeId`**, keeping its stations and history.

**Explicit wake in this slice; automatic wake later.** A Wake control in the
console, plus wake-on-provision. Automatic wake — any station verb against a
sleeping node wakes it and retries — is the better experience and the larger
change, because it touches the broker's offline path and forces everything
downstream to tolerate seconds of latency. Clean seam; the explicit form is
useful alone.

### Asleep is a state, and the hub must be told

When Cloudflare sleeps a container on its own timer, the hub sees only that the
node stopped heartbeating. It cannot distinguish **slept normally** from **died**,
and showing `offline` for a routine expected condition is precisely the dishonest
status this codebase has been bitten by repeatedly — a scanner grading machines A
without reading them, a runtime reporting success while restart-looping.

So the worker **tells** the hub. Its container `onStop` hook posts to a small
authenticated hub endpoint, which sets the runtime's status to `asleep`.

- `runtime_status` gains **`asleep`**, alongside `provisioning · online · stopped
  · error · destroyed`. `stopped` already exists and means *deliberately stopped
  by an operator*; conflating the two would lose the distinction between "I
  stopped this" and "it idled out", which is the one an operator needs.
- **The node still goes `offline`, and that is correct.** There is genuinely no
  connection. The sweeper is untouched: it is not wrong, and teaching it about
  sleeping nodes would couple it to a substrate.
- The console shows the *runtime* as asleep with a Wake control, so a sleeping
  station reads as normal rather than broken.

`sleepAfter` is configurable on the worker, defaulting to **15 minutes** — long
enough that a short pause in a conversation does not cost a wake, short enough
that an abandoned station stops billing the same hour.

### Two pieces

**A new worker** (`cloudflare/worker-v2/`, alongside the dead one until it is deleted),
built on `@cloudflare/containers`. It exposes exactly what the driver needs:

| Route | Purpose |
|---|---|
| `POST /sandbox` | Start a container for a runtime, with hub URL and enrolment token in its environment |
| `DELETE /sandbox/:id` | Destroy it |
| `POST /sandbox/:id/stop` · `/start` | Lifecycle, mapping to the driver's optional `stop`/`start`. `start` is also the wake path — the spike confirmed `stop` then `start` restarts a container reliably. |
| `GET /health` | Liveness, for the driver to fail fast on a misconfigured URL |

Authenticated with a shared bearer token, as the old one was.

**A new image**, `agentpod-node` on a slim base with the standard entrypoint — the same
enrol-then-run contract every other runtime image uses. Not the OpenCode image: harness
selection is `imageForHarness`'s job, and baking one harness into the substrate is what
made the old worker unusable.

Because Cloudflare bakes the image at deploy time rather than per request, **`ProvisionSpec.image`
cannot be honoured.** The driver must reject a spec whose image is not the one the worker
was deployed with, rather than silently ignoring it — silently ignoring inputs is precisely
how the old driver would have failed.

### The driver

`CloudflareSandboxProvisioner`, replacing the dead `CloudflareRuntimeProvisioner`:

- `provision` → `POST /sandbox`, returns the sandbox id as `externalId`
- `destroy` → `DELETE /sandbox/:id`
- `start` / `stop` → the lifecycle routes
- `runtime` → reports `"cloudflare-container"`, so the console's Isolation column says
  something true rather than nothing

Every response is validated against an expected shape. The dead driver's failure was an
`ASSUMPTION` comment about the worker's contract that nobody checked; this one asserts it
and fails loudly when it does not hold.

### Registration

Keeps the existing `ENABLE_CLOUDFLARE_SANDBOXES` flag and registry entry, so no registry
work is needed — the provider name is already in the union. `CLOUDFLARE_WORKER_URL` and
`CLOUDFLARE_API_TOKEN` are read through the same env path as today.

## Out of scope

- **Automatic wake on demand** — deferred. Any station verb waking a sleeping
  node and retrying is the better experience, but it changes the broker's offline
  path and every caller's latency assumptions. Explicit wake first.
- **Opening the registry** — `cloudflare` is already a known provider; nothing here needs
  dynamic names or capability manifests.
- **Deleting the old worker and driver** — they stay marked dead until this replaces them
  in production, so there is always a working reference during the transition.
- **Preview URLs, R2 workspace storage, Workflows** — all OpenCode-era concepts with no
  place in the fleet model.

## Testing

- **Sleeping sets `asleep`, not `offline` or `error`** — the callback path, and the
  distinction an operator relies on to tell "idled out" from "broken".
- **A wake resumes the same `nodeId`** — the acceptance test for the whole slice,
  and the one that exercises identity persistence on the substrate that needs it.
- **`stopped` and `asleep` stay distinct** — an operator-stopped runtime must not
  be reported as having idled out, or the console loses the difference between
  "I did that" and "it happened".
- **Driver unit tests against a fake fetch**, mirroring the existing cloudflare tests:
  provision posts the right body, destroy targets the right id, lifecycle maps correctly.
- **A response that does not match the expected shape fails the provision** — the specific
  bug the dead driver would have had.
- **A spec whose image differs from the deployed one is rejected**, not ignored.
- **Worker tests** with `vitest` + `@cloudflare/vitest-pool-workers` for routing and auth.
- **Live verification, through `createRuntime` rather than by hand** — the discipline that
  found #243 and would have caught the dead worker. A provisioned Cloudflare runtime must
  reach `status=online` with a real node heartbeating, then survive a restart with the same
  `nodeId`, which is what proves the dependency above actually works.

## Known limits

**Image is fixed at worker deploy time.** Changing harness image means redeploying the
worker. That is a platform property, not a design choice, and it makes Cloudflare a poor
fit for per-runtime harness selection.

**A wake costs seconds.** A woken container boots, enrols and reconnects before the
station is usable. Explicit wake makes that latency visible and attributable,
which is part of why it comes first.

**Even sleeping, this is not the default substrate.** ~$2/month idle per station
beats always-on by 12×, but a Hetzner box runs the whole fleet for about €46.
Cloudflare earns burst, untrusted code and geography.

**Ephemeral disk means a restarted station loses its workspace**, not just its identity.
Identity is solved by the dependency; workspace persistence is not, and a Cloudflare
station should be treated as disposable until it is.
