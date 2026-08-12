# Cloudflare Sandbox spike — findings

**Date:** 2026-08-12
**Question:** can a Cloudflare container host an AgentPod station, and what does sleep do to it?
**Verdict: yes, with one mandatory design consequence.** Build it, and persist node identity outside the container.

Run against the production hub with a real `agentpod-node` binary in a purpose-built
image, deployed to Cloudflare with `wrangler`. Torn down afterwards: worker deleted,
node row removed, no residue.

## What was tested

A minimal worker (`@cloudflare/containers@0.3.7`) with a `Container` subclass at
`sleepAfter = "2m"`, and a Debian image carrying `agentpod-node` plus an entrypoint that
enrols on first boot and then runs. `POST /spawn` started it with `AGENTPOD_HUB_URL` and
a one-time enrolment token in the container environment.

## Results

| # | Question | Answer |
|---|---|---|
| 1 | Does a Cloudflare container enrol and connect at all? | **Yes.** Online in ~20s, `hostname=cloudchamber`, heartbeating. |
| 2 | Does it survive `sleepAfter`? | **Yes.** Online across a full 9-minute window at `sleepAfter="2m"` — 4.5× the timeout, one continuous process, one enrolment, zero restarts. |
| 3 | *Why* does it survive? | **`onActivityExpired()` fires and the override renews the timer**, exactly as documented. Observed in the tail: `[spike] activity expired — NOT stopping` at 02:49:52, container still running after. |
| 4 | Does identity survive a restart? | **No.** After an explicit stop and a wake with no token, the container restarted cleanly (`NodeAgentContainer.start - Ok`, `[spike] container started`) and the node **never came back online** — still offline 135s later. |
| 5 | Does the wake path work? | **Yes**, at the platform level. `POST /wake/:id` restarted the container reliably. |

## The one mandatory consequence

**Node identity must live outside the container.**

Cloudflare documents container disk as ephemeral: a restart gets "a fresh disk as defined
by its container image". AgentPod persists its identity — `nodeId` and secret — to
`/root/.config/agentpod-node/config.json`. So a restart destroys it, and because enrolment
tokens are one-time, the node cannot simply enrol again.

**This is not a sleep workaround.** It applies to every restart: eviction, deploy, crash,
platform maintenance. Any ephemeral-disk substrate needs it. Sleep is merely the most
frequent trigger.

Result #2 makes this *less* urgent than feared — a station can stay up indefinitely — but
not optional, because "indefinitely" still ends at the first eviction.

## What this changes about the plan

**Sleep is a solved problem, not a blocker.** The original concern — that Cloudflare's
activity timer is driven by incoming requests, and a node-agent receives none
([cloudflare/containers#147](https://github.com/cloudflare/containers/issues/147)) — is
real but has a documented, verified lever. A station can be kept alive by declining to
stop on expiry.

**That means the sleep/wake state machine is a cost optimisation, not a correctness
requirement.** A first Cloudflare driver can ship with always-on containers and be
correct. Scale-to-zero — "asleep" as a state distinct from "offline", waking on demand —
becomes a later, optional economic win rather than a prerequisite.

**Identity persistence moves from "nice" to "required", and moves first.** It is the only
thing standing between a working driver and a fleet that silently loses stations.

Suggested order, revised from "sleep/wake and Cloudflare together":

1. **Identity persistence** — a node resumes an existing `nodeId` after a restart rather
   than re-enrolling. Needed by any ephemeral substrate; not Cloudflare-specific.
2. **The Cloudflare driver** — new worker, new image, always-on containers.
3. **Sleep/wake as a state** — only once someone wants the cost saving.

## Cost, for the decision

At `standard-1` (½ vCPU, 4 GiB), always-on, memory is billed on provisioned resources:
roughly **$28/month per station**, about **$1,090/month across 39**. A Hetzner AX41 is
about €46/month and would run that fleet. Cloudflare earns its place for burst, untrusted
code, and geography — not as the default substrate for standing stations. That is an
argument for keeping the operated substrate primary, which is what the roadmap already
says.

## Correction, added 2026-08-12 after building the driver

**Finding #4 named one cause where there were two.** The spike concluded that a
woken container did not come back *because container disk is ephemeral and the
node identity was lost*. That is true, and #245 was the right fix — but the spike
worker's wake path also called `container.start()` with **no `envVars`**, and a
container's environment does not survive a stop. So the woken container had no
`AGENTPOD_HUB_URL` and no `AGENTPOD_ENROLL_TOKEN`, failed `agentpod-node enroll`,
exited under `set -e`, and was restarted forever.

Both faults produce the identical symptom — "the node never came back" — and the
spike could not tell them apart because it only observed the outcome. The second
was found only when the real driver reproduced it and `wrangler containers list`
showed **7 live instances** in a silent restart loop.

The lesson is narrower than "test more": when one observation is explained by a
hypothesis you already hold, that is exactly when a second cause hides behind it.

## Corrections to earlier claims in this investigation

- I reported that `onActivityExpired` "never fired" based on an empty tail. **Wrong** — the
  tail had simply started after the firing. It fires, and the override works. This matters:
  the survival is a documented mechanism, not unexplained behaviour, and can be designed
  around.
- A worker redeploy does **not** restart a running container when the image digest is
  unchanged. Forcing a restart needs an explicit stop.
