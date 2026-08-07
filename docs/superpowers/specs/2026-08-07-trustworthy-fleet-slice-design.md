# Trustworthy Fleet Slice — Design

**Date:** 2026-08-07
**Issues:** #47 (reconciliation), #161 (re-enroll), #149 (auth secret), + new issue for release-pipeline hardening
**Goal:** make the console's view of the fleet — and the update pipeline that keeps it current — trustworthy under reconnects, hub restarts, node re-installs, and CI flakes.

## Scope

Four items, shipped as one slice on `develop`, one commit per item closing its issue:

1. **#47** — node online/offline reconciliation (hub only)
2. **#161** — self-healing re-enroll (node-agent + one hub endpoint)
3. **#149** — auth secret tidy-up (hub only)
4. **Release-pipeline hardening** (CI only; issue to be filed)

Out of scope: #88 (lifecycle/cleanup verification) — exercised opportunistically when the fleet rolls to the new version, not designed here. No schema migrations. No console changes (status rendering already exists).

## 1. Node online/offline reconciliation (#47)

Files: `apps/hub/src/routes/gateway.ts`, `apps/hub/src/services/node-registry.ts`, `apps/hub/src/services/connection-manager.ts`, hub boot path in `apps/hub/src/index.ts`.

Fleet cadence facts the design rests on: agent heartbeat every **15s**, health push every 30s, reconnect backoff cap 30s.

### 1a. Connection epoch guard

Each accepted socket gets a unique epoch (its registered send-function identity, or a monotonic counter held by `connectionManager`). `onClose` performs teardown (unregister, `dropNode`, health-cache `clearNode`, `setNodeStatus offline`) **only if the closing socket is still the currently registered one** for that nodeId. Fixes the core race: a node reconnects, then the *old* socket's late close fires and wrongly marks the fresh connection offline / drops its send entry.

### 1b. Heartbeat re-registers

When a heartbeat arrives on a socket that has no current `connectionManager` entry (swept, or lost to a close race), the handler re-registers that socket's send function — not merely `setNodeStatus(online)`. Server→node messaging then works for any node that is heartbeating, and any false-positive sweep self-corrects within ≤15s.

### 1c. Startup reconciliation

On hub boot, before accepting gateway connections: `UPDATE nodes SET status='offline' WHERE status='online'`. Removes ghost-online rows after a hub restart; agents reconnect within ~30s and flip themselves back.

### 1d. Heartbeat sweeper

A hub interval (every **15s**) expires nodes with `status='online'` whose `lastSeenAt` is older than **45s** (3 missed heartbeats), running the same full teardown path as a real close. Catches connections whose TCP close never fires (killed VM, dropped network). Threshold and clock are injectable for tests.

### 1e. lastSeenAt honesty

`setNodeStatus(nodeId, "offline")` stops bumping `lastSeenAt`; "last seen" means last actual contact. Online transitions keep bumping it. This keeps the sweeper's math correct and the UI's "last seen" honest.

### Testing

Hub integration tests: (1) two sockets for one nodeId, old socket closes late → node stays online, new send entry intact; (2) heartbeat after a dropped entry restores server→node send (a `broker.request` succeeds); (3) boot-time reset flips orphaned online rows; (4) sweeper expires a silent node at threshold and not before (injected clock).

## 2. Self-healing re-enroll (#161)

Files: `apps/node-agent` enroll command + config; new hub route.

### Hub endpoint

`GET /public/nodes/credential-check`, auth `Bearer <nodeId>:<nodeSecret>` (same scheme as the gateway), reusing `verifyNodeCredential`. Returns 200 when valid, 401 when not. No state change.

### Agent enroll decision flow (config file already exists)

1. `--force` flag → re-enroll with the provided token; overwrite config.
2. Stored hub URL ≠ requested hub URL → re-enroll (identity is meaningless on a different hub).
3. Same hub → call `credential-check` with stored credential.
   - **200** → keep config; print `already enrolled as <id>, credential verified`. Container restarts stay idempotent; one-time token untouched.
   - **401** → hub no longer knows this node (wipe/delete) → re-enroll with the fresh token.
4. Hub unreachable → keep existing config, print a warning, **exit 0**. Never destroy a possibly-valid identity on a network blip; never block the container entrypoint (`run` retries connecting anyway).

No config file present → enroll as today. `install.sh` needs no logic change — it delegates to `enroll`.

### Testing

Go table tests over the four branches with an `httptest` hub stub (valid / 401 / hub-mismatch / unreachable), plus `--force`.

## 3. Auth secret tidy-up (#149)

Files: `apps/hub/src/config.ts`, `apps/hub/src/auth/drizzle-auth.ts` (or wherever `betterAuth()` is constructed).

Rename config's `SESSION_SECRET` → `BETTER_AUTH_SECRET`, keep the existing validation, and pass it explicitly as `betterAuth({ secret })`. Config becomes the single source of truth instead of Better Auth's implicit env read. Docs and prod `/etc/agentpod/hub.env` already use `BETTER_AUTH_SECRET` — no deploy-time change. Remove remaining `SESSION_SECRET` references (code, `.env.example`, docs).

## 4. Release-pipeline hardening

File: `.github/workflows/release-node-agent.yml`. (Issue to be filed on the board.)

- **Step retries:** wrap the flake-prone build/upload steps in a plain bash retry loop (3 attempts) — no new action dependency. Covers the observed transient failures ("Too many retries" on upload; no-log runner deaths recover on retry only at job level, which stays a manual `gh run rerun --failed`).
- **Decouple SHA256SUMS:** run the `SHA256SUMS` + static-assets jobs with `if: ${{ !cancelled() }}`, computing sums over whatever binaries actually reached the release. A hard arch failure now degrades to "that arch can't self-update this tag" instead of "no node can verify the update". The workflow still reports red when an arch is missing, so it gets noticed and re-run.

Both current fleet nodes are linux/amd64; a darwin flake must never again block a fleet roll.

## Rollout

1. Land all four items on `develop`; PR `develop` → `main`.
2. Hub: VPS `git pull` (or `merge --ff-only`, see the stale-ref quirk in ops notes) + `systemctl restart agentpod-hub`.
3. Tag `v0.1.10` → release workflow builds node-agent binaries (first exercise of the hardened pipeline).
4. Roll the fleet from the console (one-click update per node) — opportunistically exercising #88's lifecycle verification.
5. Verify live: reconnect/restart scenarios show honest status; a stale-config re-enroll heals itself.

## Ordering

Independent items; suggested order: #149 (smallest) → #47 → #161 → pipeline hardening (so the tag that ships #47/#161 already uses the hardened workflow... note the workflow runs from the *tag's* ref, so land it before tagging).
