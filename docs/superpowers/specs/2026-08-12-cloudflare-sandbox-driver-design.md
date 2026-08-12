# Cloudflare Sandbox driver — design

**Status:** approved 2026-08-12
**Horizon:** 1 — step 3 of the re-planned driver wave
**Depends on:** `2026-08-12-runtime-identity-persistence-design.md` (hard dependency)
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

### Always-on, not scale-to-zero

Containers keep themselves alive by overriding `onActivityExpired()` and declining to stop.

The alternative — letting them sleep and waking on demand — is a **cost optimisation**, and
the spike showed it is not needed for correctness. Deferring it keeps this driver small and
keeps "asleep" out of the station state machine until someone wants the saving.

The cost is stated plainly so the choice is informed: roughly **$28/month per always-on
4 GiB station**, about **$1,090/month across 39**, against ~€46/month for a Hetzner box
that would run the fleet. Cloudflare earns burst, untrusted code and geography — it is not
the default substrate for standing stations, and the roadmap already says so.

### Two pieces

**A new worker** (`cloudflare/worker-v2/`, alongside the dead one until it is deleted),
built on `@cloudflare/containers`. It exposes exactly what the driver needs:

| Route | Purpose |
|---|---|
| `POST /sandbox` | Start a container for a runtime, with hub URL and enrolment token in its environment |
| `DELETE /sandbox/:id` | Destroy it |
| `POST /sandbox/:id/stop` · `/start` | Lifecycle, mapping to the driver's optional `stop`/`start` |
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

- **Sleep/wake as a station state** — deferred, see above.
- **Opening the registry** — `cloudflare` is already a known provider; nothing here needs
  dynamic names or capability manifests.
- **Deleting the old worker and driver** — they stay marked dead until this replaces them
  in production, so there is always a working reference during the transition.
- **Preview URLs, R2 workspace storage, Workflows** — all OpenCode-era concepts with no
  place in the fleet model.

## Testing

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

**Always-on costs real money.** Documented above. Not the default substrate.

**Ephemeral disk means a restarted station loses its workspace**, not just its identity.
Identity is solved by the dependency; workspace persistence is not, and a Cloudflare
station should be treated as disposable until it is.
