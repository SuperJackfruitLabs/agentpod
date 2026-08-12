# Runtime identity persistence — design

**Status:** approved 2026-08-12
**Horizon:** 1 — prerequisite for the Cloudflare driver, but not specific to it
**Evidence:** `docs/superpowers/specs/2026-08-12-cloudflare-sandbox-spike-findings.md`

## Problem

A provisioned runtime that restarts **silently becomes a different node, or no node at all.**

Node identity — `nodeId` and secret — lives at `/root/.config/agentpod-node/config.json`
inside the container. On a substrate with ephemeral disk, a restart destroys it. The
container's entrypoint then runs `agentpod-node enroll` again, and `enrollNode` mints a
**brand new node**, orphaning the runtime's original one.

Verified 2026-08-12 on a real Cloudflare container: stopped, woken, container restarted
cleanly, node never came back online.

**This is not Cloudflare-specific.** It applies to any restart on any ephemeral-disk
substrate — eviction, redeploy, crash, platform maintenance. Cloudflare merely makes it
routine rather than rare.

Docker is currently unaffected only because container restarts preserve the writable
layer. That is a property of the substrate, not a guarantee of the design, and it will not
hold for the next driver either.

## What already works — do not rebuild it

**The node-agent is already idempotent.** `decideEnroll` / `alreadyEnrolled` in
`cmd/agentpod-node/main.go` make a bare `enroll` a friendly no-op when config is present,
and there is an `enroll_idempotent_test.go` covering it. The runtime image's entrypoint
already calls `enroll` unconditionally on every start.

**The schema already links the pieces.** `enrollment_tokens.provisionedRuntimeId` exists,
and `enrollNode` already writes `nodeId` back onto the runtime row on success.

So this needs **no node-agent change at all.** The entire gap is one behaviour in the hub.

## The gap

`enrollNode` does two things unconditionally:

1. **Consumes the token** — sets `usedAt`, so it can never be presented again.
2. **Mints a new node** — a fresh `nodeId` and secret every time.

For a provisioned runtime, both are wrong. The runtime *has* an identity; a restart should
resume it, not replace it.

## Design

### Runtime-bound re-enrolment

When a token carries a `provisionedRuntimeId` **and** that runtime already has a `nodeId`,
`enrollNode` returns **that node**, with a freshly rotated secret, instead of creating a
new one.

Three properties fall out, and each matters:

**The node keeps its identity.** Stations, adopted capabilities, audit history and console
links all survive a restart. Today they are orphaned.

**The secret rotates on every restart.** The container never needs durable storage for it,
and a secret that leaked from a previous incarnation stops working. Rotation is a
consequence of the design rather than an extra feature.

**Nothing is stored substrate-side.** No Durable Object storage, no R2, no per-driver
persistence code. The hub is already the authority on identity; this makes it act like it.

### Token reuse, scoped

Runtime-bound tokens become **reusable**; unbound tokens stay strictly one-time.

That asymmetry is the whole security argument, so it is worth stating plainly. A one-time
token is a bearer credential that stops mattering the moment it is used. A reusable one is
a durable credential, and a durable credential in a container's environment is exactly the
kind of thing `apn scan` exists to complain about.

It is acceptable here because it is **bounded three ways**:

- It resolves to exactly one runtime, and therefore one node — presenting it cannot create
  anything new or reach anything else.
- It is already in that container's environment today; this changes its lifetime, not its
  exposure.
- Destroying the runtime revokes it, and that is an action the console already offers.

`usedAt` is still stamped on first use, for audit. It stops being a *gate* for
runtime-bound tokens and remains one for everything else.

### Expiry

A runtime-bound token must outlive its runtime, so it is minted with no expiry.

An unbound token keeps its current short expiry, because it is handed to a human who is
about to paste it into a shell.

The two now differ in both reuse and lifetime, which is why the code path branches on
`provisionedRuntimeId` rather than on a flag someone can set independently — there is
exactly one kind of token that gets the durable treatment, and it is the kind the hub
mints for itself.

### What happens on each path

| Situation | Behaviour |
|---|---|
| Unbound token, unused | Mint a new node. Consume the token. *(unchanged)* |
| Unbound token, already used | Reject. *(unchanged)* |
| Unbound token, expired | Reject. *(unchanged)* |
| Runtime-bound token, runtime has no node yet | Mint a new node, link it to the runtime, stamp `usedAt`. *(first boot)* |
| Runtime-bound token, runtime already has a node | **Return that node with a rotated secret.** *(restart — new)* |
| Runtime-bound token, runtime row deleted | Reject. The runtime is gone; its identity should not be resurrectable. |

That last row is deliberate. `provisionedRuntimeId` is `on delete set null`, so a destroyed
runtime leaves a token pointing at nothing — and a token that once meant "this runtime"
must not silently degrade into "mint me anything".

### Concurrency

The current implementation is careful about this and the change must not weaken it: a
single atomic `UPDATE ... RETURNING` consumes the token, deliberately closing a TOCTOU race
where two concurrent enrolments could both pass a `SELECT` guard.

Runtime-bound re-enrolment cannot use that trick, because it must *not* gate on `usedAt`.
Two containers starting at once must therefore not produce two nodes. The rotation is
performed as a conditional update against the runtime's existing `nodeId`, so concurrent
re-enrolments converge on one node; the loser sees the winner's secret rotation and its
credential simply fails, which the node-agent already handles by reconnecting.

## Out of scope

- **Sleep/wake as a station state.** The spike showed a container can stay alive
  indefinitely via `onActivityExpired`, so scale-to-zero is a cost optimisation, not a
  correctness requirement.
- **Any node-agent change.** It is already idempotent.
- **Substrate-side storage.** Explicitly rejected: it would duplicate per driver.
- **Re-enrolment for non-provisioned nodes.** A hand-enrolled VPS keeps its config on disk;
  there is no runtime row to bind to and no problem to solve.

## Testing

- **A runtime-bound token used twice returns the same `nodeId`** — the headline behaviour,
  and the one that currently fails.
- **The secret rotates**: the second enrolment's secret verifies, the first no longer does.
- **An unbound token is still strictly one-time** — the security property this change must
  not erode.
- **A runtime-bound token whose runtime row is gone is rejected**, not treated as unbound.
- **First boot still mints and links**, so the existing provisioning path is untouched.
- **Concurrent re-enrolment converges on one node** — two overlapping calls, one `nodeId`.
- **Station rows survive** a re-enrolment: adopted stations still point at the same node.
- Existing enrolment tests must pass unchanged.

Per repo convention, every test is written failing first.

## Known limits

**A reusable token is a longer-lived credential than before.** Bounded as described, and
already present in the container's environment, but it is a real change in exposure and is
recorded here rather than buried.

**Rotation invalidates any concurrently-connected old incarnation.** If a previous
container is somehow still running when a new one enrols, the old one's credential stops
working and it drops. That is the correct outcome — one runtime, one live node — but it
means a restart is not gentle to a lingering predecessor.
