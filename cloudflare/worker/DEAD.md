# This worker is dead — do not use it as a reference

**Status: dead as of 2026-08-12.** It is kept in the tree for the SDK usage
patterns only. It cannot provision a fleet runtime and never could.

It was written in the **OpenCode era**, when the hub drove OpenCode over HTTP
inside a sandbox. The fleet architecture is the inverse: a `agentpod-node`
binary runs in the sandbox, dials the hub outbound over WSS, and enrols itself.
Nothing here does that.

## Why it cannot work, checked 2026-08-12

| Blocker | Detail |
|---|---|
| **Wrong image** | `Dockerfile` is `cloudflare/sandbox:0.6.7` + OpenCode. There is no `agentpod-node` binary, so nothing can ever enrol. |
| **Image is not per-request** | `wrangler.toml` bakes it: `[[containers]] image = "./Dockerfile"`. `ProvisionSpec.image`, which the hub driver dutifully sends, is structurally meaningless here. |
| **Enrolment token is dropped** | `CreateSandboxBody` has no `env` field. The driver sends `env: { AGENTPOD_HUB_URL, AGENTPOD_ENROLL_TOKEN }` and the worker ignores it. Zero occurrences of either variable in `src/`. |
| **Wrong architecture** | `handleCreateSandbox` calls `createOpencodeServer`, and `AGENTPOD_API_URL` points at `https://api.agentpod.app` — a domain that no longer exists. The hub is `hub.agentpod.dev`. |

## The trap it sets

The **routes match** what `apps/hub/src/services/provisioner/cloudflare.ts`
assumes — `POST /sandbox`, `DELETE /sandbox/:id`. So a provision would return
2xx, the driver would report success and persist an `externalId`, and the
runtime row would sit in `provisioning` forever with no error anywhere.

That silent-success shape is the same one that produced
[#243](https://github.com/rakeshgangwar/agentpod/issues/243). Code that returns
2xx while doing the wrong thing is worse than code that fails.

## What replaces it

A new worker built on the modern `@cloudflare/sandbox` SDK (Sandboxes reached GA
in April 2026), carrying `agentpod-node` and passing the hub URL and enrolment
token into the sandbox environment.

Also relevant: this worker already has a `POST /sandbox/:id/wake` route. Sandboxes
sleep on inactivity, and under our dial-out model **a slept sandbox is an offline
station** — so wake is not an optimisation here, it is a requirement.
