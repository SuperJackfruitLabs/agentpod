# Runtime Identity Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A provisioned runtime that restarts resumes its existing node instead of orphaning it and minting a new one.

**Architecture:** Entirely hub-side. When an enrolment token carries a `provisionedRuntimeId` whose runtime already has a `nodeId`, `enrollNode` returns that node with a rotated secret rather than creating a new one. Such tokens become reusable and non-expiring; every other token keeps today's strict one-time, short-lived behaviour.

**Tech Stack:** Bun + Hono + Drizzle/Postgres.

**Spec:** `docs/superpowers/specs/2026-08-12-runtime-identity-persistence-design.md`

## Global Constraints

- **No node-agent change.** It is already idempotent (`decideEnroll`, `alreadyEnrolled`, `enroll_idempotent_test.go`) and the runtime image entrypoint already calls `enroll` on every start.
- **Unbound tokens must remain strictly one-time and short-lived.** This is the security property the change must not erode; it has its own test.
- **The existing TOCTOU protection must not weaken.** Today a single atomic `UPDATE ... RETURNING` consumes the token so two concurrent enrolments cannot both pass a `SELECT` guard. Runtime-bound re-enrolment cannot gate on `usedAt`, so it needs its own convergence guarantee.
- **A runtime-bound token whose runtime row is gone is rejected**, never silently degraded to unbound. `provisionedRuntimeId` is `on delete set null`.
- Branch: `runtime-identity-persistence` off `main`. Single PR.
- TDD: every task writes its failing test first.

## Existing behaviour worth knowing before you start

`apps/hub/src/services/enrollment.ts`:

- `mintEnrollmentToken(userId, opts?)` — `opts.ttlMs` defaults to 1 hour; `opts.provisionedRuntimeId` links the token to a runtime.
- `enrollNode(token, hostInfo)` — hashes the token, then **atomically** consumes it with `UPDATE enrollment_tokens SET usedAt = now() WHERE tokenHash = ? AND usedAt IS NULL AND expiresAt > now() RETURNING *`. If no row comes back it throws `"invalid or expired enrollment token"`. It then mints a new `nodeId` + `nodeSecret`, inserts the node, and — when `row.provisionedRuntimeId` is set — writes `nodeId` back onto the runtime and flips it to `online`.
- `verifyNodeCredential(nodeId, nodeSecret)` — `Bun.password.verify` against `nodes.secretHash`.

Tests live in `apps/hub/tests/integration/enrollment.test.ts` and already cover `mint → enroll → verify → list`, `a token cannot be reused`, and `concurrent enrollments with the same token — exactly one succeeds`. **Those three must still pass unchanged.**

## File Structure

**`apps/hub`**
- `src/services/enrollment.ts` *(modify)* — the whole behaviour change lives here.
- `tests/integration/enrollment.test.ts` *(modify)* — re-enrolment, rotation, rejection, concurrency.
- `src/services/runtimes.ts` *(modify)* — mint runtime-bound tokens as durable.

---

## Task 1: Runtime-bound tokens are durable at mint time

A runtime-bound token must outlive its runtime, so it is minted with no expiry. Doing this first means Task 2's re-enrolment has a token that is still valid to re-present.

**Files:**
- Modify: `apps/hub/src/services/enrollment.ts` (`mintEnrollmentToken`)
- Modify: `apps/hub/tests/integration/enrollment.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mintEnrollmentToken` sets a far-future `expiresAt` when `provisionedRuntimeId` is present; unbound tokens keep the 1-hour default. Exported constant `RUNTIME_TOKEN_TTL_MS`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/hub/tests/integration/enrollment.test.ts`, inside the existing top-level `describe` block (match its indentation):

```ts
  test("a runtime-bound token is minted durable, an unbound one is not", async () => {
    // A runtime-bound token has to survive as long as its runtime — it is
    // re-presented on every container restart, which may be months later. An
    // unbound token is pasted into a shell by a human within the hour.
    const runtimeId = await seedRuntime(TEST_USER_ID);

    const bound = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });
    const unbound = await mintEnrollmentToken(TEST_USER_ID);

    const oneDay = 24 * 60 * 60 * 1000;
    expect(bound.expiresAt.getTime() - Date.now()).toBeGreaterThan(oneDay);
    expect(unbound.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
  });

  test("an explicit ttlMs still wins for a runtime-bound token", async () => {
    // The durable default must not take away a caller's ability to say
    // otherwise — tests and future callers may want a short-lived bound token.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const t = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
      ttlMs: 60_000,
    });
    expect(t.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(65_000);
  });
```

Add this helper near the other fixtures at the top of the file, after `TEST_USER_ID`:

```ts
/**
 * Insert a provisioned_runtimes row and return its id.
 *
 * Written directly rather than through createRuntime() so these tests need no
 * provisioner registration — the identity behaviour under test is independent
 * of which driver created the runtime.
 */
async function seedRuntime(userId: string): Promise<string> {
  const id = `rt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await rawSql`
    INSERT INTO provisioned_runtimes (id, user_id, provider, status, name, resource_tier, harness, created_at, updated_at)
    VALUES (${id}, ${userId}, 'docker', 'provisioning', 'identity-test', 'small', 'none', now(), now())
  `;
  return id;
}
```

Add `provisioned_runtimes` to the `afterAll` cleanup in that file so these rows do not leak between runs — read the existing `afterAll` and add a matching `DELETE` before the `nodes` delete (runtimes reference nodes, so order matters).

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/enrollment.test.ts
```

Expected: the first test FAILS — a bound token currently expires in 1 hour like any other. The second passes already, which is the point: it pins that an explicit `ttlMs` keeps winning.

- [ ] **Step 3: Implement it**

In `apps/hub/src/services/enrollment.ts`, add above `mintEnrollmentToken`:

```ts
/**
 * Lifetime for a runtime-bound token: ten years, i.e. "as long as the runtime".
 *
 * A runtime-bound token is re-presented on every container restart, which on an
 * ephemeral-disk substrate is routine and may happen long after provisioning.
 * An expiry here would mean a runtime that silently stops being able to come
 * back — the exact failure this work exists to remove.
 *
 * It is revoked by destroying the runtime, not by waiting.
 */
export const RUNTIME_TOKEN_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
```

Then change the `ttlMs` line in `mintEnrollmentToken`:

```ts
  const ttlMs =
    opts?.ttlMs ?? (opts?.provisionedRuntimeId ? RUNTIME_TOKEN_TTL_MS : 60 * 60 * 1000);
```

Update that function's doc comment so the default is not misdescribed — change the `ttlMs` line to:

```
 *   - ttlMs              — token lifetime in ms. Defaults to 1 hour, or
 *                          RUNTIME_TOKEN_TTL_MS when provisionedRuntimeId is set.
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/enrollment.test.ts
```

Expected: PASS, including the three pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/enrollment.ts apps/hub/tests/integration/enrollment.test.ts
git commit -m "feat(hub): runtime-bound enrollment tokens are durable"
```

---

## Task 2: Re-enrolment resumes the runtime's existing node

The core change.

**Files:**
- Modify: `apps/hub/src/services/enrollment.ts` (`enrollNode`)
- Modify: `apps/hub/tests/integration/enrollment.test.ts`

**Interfaces:**
- Consumes: `RUNTIME_TOKEN_TTL_MS` and `seedRuntime` from Task 1.
- Produces: `enrollNode` returns the runtime's existing `nodeId` with a rotated secret on re-presentation of a runtime-bound token. Signature unchanged: `enrollNode(token: string, hostInfo: HostInfo): Promise<EnrollResponse>`.

- [ ] **Step 1: Write the failing tests**

Append inside the same `describe` block:

```ts
  test("re-enrolling a runtime-bound token returns the SAME node", async () => {
    // The headline behaviour. On an ephemeral-disk substrate the container
    // re-enrols on every restart; today that mints a new node and orphans the
    // old one, so the runtime loses its stations, capabilities and history.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });

    const first = await enrollNode(token, HOST_INFO);
    const second = await enrollNode(token, HOST_INFO);

    expect(second.nodeId).toBe(first.nodeId);
  });

  test("re-enrolment rotates the secret and invalidates the old one", async () => {
    // The container never stores a secret durably, so a fresh one each restart
    // costs nothing — and a secret that leaked from a previous incarnation
    // stops working.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });

    const first = await enrollNode(token, HOST_INFO);
    const second = await enrollNode(token, HOST_INFO);

    expect(second.nodeSecret).not.toBe(first.nodeSecret);
    expect(await verifyNodeCredential(second.nodeId, second.nodeSecret)).toBe(true);
    expect(await verifyNodeCredential(first.nodeId, first.nodeSecret)).toBe(false);
  });

  test("re-enrolment does not create a second node", async () => {
    // Guards the orphaning directly: counting rows catches a bug that returning
    // the right id from the wrong code path would hide.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });

    await enrollNode(token, HOST_INFO);
    await enrollNode(token, HOST_INFO);
    await enrollNode(token, HOST_INFO);

    const rows = await rawSql`
      SELECT node_id FROM provisioned_runtimes WHERE id = ${runtimeId}
    ` as Array<{ node_id: string }>;
    const nodeId = rows[0]!.node_id;

    const nodeRows = await rawSql`
      SELECT count(*)::int AS n FROM nodes WHERE id = ${nodeId}
    ` as Array<{ n: number }>;
    expect(nodeRows[0]!.n).toBe(1);
  });

  test("an unbound token is still strictly one-time", async () => {
    // The security property this change must not erode. A reusable token is a
    // durable credential; only runtime-bound ones earn that, because they
    // resolve to exactly one runtime and are revoked by destroying it.
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    await enrollNode(token, HOST_INFO);
    await expect(enrollNode(token, HOST_INFO)).rejects.toThrow(
      /invalid or expired enrollment token/
    );
  });

  test("a runtime-bound token whose runtime is gone is rejected", async () => {
    // provisionedRuntimeId is ON DELETE SET NULL, so a destroyed runtime leaves
    // a token pointing at nothing. It must not silently degrade into "mint me
    // anything" — the identity it referred to is gone on purpose.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });
    await enrollNode(token, HOST_INFO);

    await rawSql`DELETE FROM provisioned_runtimes WHERE id = ${runtimeId}`;

    await expect(enrollNode(token, HOST_INFO)).rejects.toThrow();
  });

  test("first boot on a runtime-bound token still mints and links", async () => {
    // The existing provisioning path must be untouched.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });

    const { nodeId } = await enrollNode(token, HOST_INFO);

    const rows = await rawSql`
      SELECT node_id, status FROM provisioned_runtimes WHERE id = ${runtimeId}
    ` as Array<{ node_id: string; status: string }>;
    expect(rows[0]!.node_id).toBe(nodeId);
    expect(rows[0]!.status).toBe("online");
  });

  test("concurrent re-enrolment converges on one node", async () => {
    // Runtime-bound re-enrolment cannot gate on usedAt, so it loses the atomic
    // consume that protects the unbound path. Two containers starting at once
    // must still not produce two nodes.
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });
    const { nodeId } = await enrollNode(token, HOST_INFO);

    const results = await Promise.allSettled([
      enrollNode(token, HOST_INFO),
      enrollNode(token, HOST_INFO),
    ]);
    for (const r of results) {
      if (r.status === "fulfilled") expect(r.value.nodeId).toBe(nodeId);
    }

    const nodeRows = await rawSql`
      SELECT count(*)::int AS n FROM nodes WHERE id = ${nodeId}
    ` as Array<{ n: number }>;
    expect(nodeRows[0]!.n).toBe(1);
  });
```

If the file has no shared `HOST_INFO` fixture, add one next to `TEST_USER_ID`:

```ts
const HOST_INFO = { hostname: "identity-test", os: "linux", arch: "amd64", cpuCount: 2 };
```

If it already has an equivalent under another name, use that name instead throughout.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/enrollment.test.ts
```

Expected: the re-enrolment tests FAIL with `invalid or expired enrollment token` — the token was consumed by the first call. `an unbound token is still strictly one-time` and `first boot` pass already; they are there to stay passing.

- [ ] **Step 3: Rewrite `enrollNode`**

Replace the body of `enrollNode` in `apps/hub/src/services/enrollment.ts`. Read the existing function first; this preserves its atomic-consume path exactly and adds a branch before it.

```ts
export async function enrollNode(
  token: string,
  hostInfo: HostInfo
): Promise<EnrollResponse> {
  const hash = await sha256(token);

  // ── Runtime-bound re-enrolment ────────────────────────────────────────────
  //
  // A provisioned runtime on an ephemeral-disk substrate loses its config on
  // every restart and re-presents this token. Minting a new node there would
  // orphan the runtime's stations, capabilities and history — so if the runtime
  // already has a node, we resume it.
  //
  // Deliberately does NOT gate on usedAt: that gate is what makes an unbound
  // token one-time, and re-presentation is the whole point here.
  const [bound] = await db
    .select()
    .from(enrollmentTokens)
    .where(
      and(
        eq(enrollmentTokens.tokenHash, hash),
        gt(enrollmentTokens.expiresAt, new Date())
      )
    );

  if (bound?.provisionedRuntimeId) {
    const [runtime] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, bound.provisionedRuntimeId));

    // The runtime was destroyed. Its identity is gone on purpose, and this
    // token must not degrade into an unbound one that mints something new.
    if (!runtime) {
      throw new Error("invalid or expired enrollment token");
    }

    if (runtime.nodeId) {
      // Rotate the secret. The container stores nothing durably, so a fresh
      // secret costs nothing and retires any that leaked from a previous
      // incarnation.
      const nodeSecret =
        crypto.randomUUID().replace(/-/g, "") +
        crypto.randomUUID().replace(/-/g, "");

      // Conditional on the node still being the runtime's: concurrent
      // re-enrolments converge here rather than creating a second node. The
      // loser's secret is simply superseded, and the node-agent reconnects.
      const updated = await db
        .update(nodes)
        .set({
          secretHash: await Bun.password.hash(nodeSecret),
          hostname: hostInfo.hostname,
          os: hostInfo.os,
          arch: hostInfo.arch,
          cpuCount: hostInfo.cpuCount,
        })
        .where(eq(nodes.id, runtime.nodeId))
        .returning();

      // The runtime points at a node row that no longer exists. Treat it as a
      // first boot rather than failing: the runtime is real and wants a node.
      if (updated.length > 0) {
        await db
          .update(provisionedRuntimes)
          .set({ status: "online", updatedAt: new Date() })
          .where(eq(provisionedRuntimes.id, runtime.id));

        return { nodeId: runtime.nodeId, nodeSecret };
      }
    }
  }

  // ── First enrolment ───────────────────────────────────────────────────────
  //
  // Atomically consume the token: mark usedAt only if the token exists, is
  // unused, and has not expired. This single UPDATE eliminates the TOCTOU race
  // where two concurrent requests could both pass a SELECT guard before either
  // writes usedAt.
  const [row] = await db
    .update(enrollmentTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(enrollmentTokens.tokenHash, hash),
        isNull(enrollmentTokens.usedAt),
        gt(enrollmentTokens.expiresAt, new Date()),
      )
    )
    .returning();

  if (!row) {
    throw new Error("invalid or expired enrollment token");
  }

  const nodeId = prefixedId("node");
  const nodeSecret =
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "");

  await db.insert(nodes).values({
    id: nodeId,
    userId: row.userId,
    name: hostInfo.hostname,
    hostname: hostInfo.hostname,
    os: hostInfo.os,
    arch: hostInfo.arch,
    cpuCount: hostInfo.cpuCount,
    secretHash: await Bun.password.hash(nodeSecret),
    status: "offline",
  });

  // If the token was minted with a provisioned runtime, link the node back to
  // it and flip its status to "online" so the runtime record reflects enrolment.
  if (row.provisionedRuntimeId) {
    await db
      .update(provisionedRuntimes)
      .set({ nodeId, status: "online", updatedAt: new Date() })
      .where(eq(provisionedRuntimes.id, row.provisionedRuntimeId));
  }

  return { nodeId, nodeSecret };
}
```

Update the function's doc comment above it:

```ts
/**
 * Enroll a node using a valid enrollment token.
 *
 * Returns the node's persistent credentials (nodeId + nodeSecret).
 *
 * Two paths:
 *   - **Runtime-bound token whose runtime already has a node** — returns that
 *     node with a rotated secret. This is what lets a runtime on an
 *     ephemeral-disk substrate survive a restart instead of orphaning itself.
 *   - **Everything else** — consumes the token atomically and mints a new node.
 *     Unbound tokens remain strictly one-time.
 *
 * Throws if the token is invalid, expired, already used (unbound only), or
 * bound to a runtime that no longer exists.
 */
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/enrollment.test.ts
```

Expected: PASS, including the three pre-existing tests — particularly `concurrent enrollments with the same token — exactly one succeeds`, which pins the unbound TOCTOU protection.

- [ ] **Step 5: Run the whole hub suite**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Expected: PASS. `runtimes.test.ts` and `node-posture.test.ts` both enrol nodes and must be unaffected.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/enrollment.ts apps/hub/tests/integration/enrollment.test.ts
git commit -m "feat(hub): a restarted runtime resumes its node instead of orphaning it"
```

---

## Task 3: Stations survive a re-enrolment

A node that keeps its id but loses its stations has not really persisted. This proves the thing operators actually care about.

**Files:**
- Modify: `apps/hub/tests/integration/enrollment.test.ts`

**Interfaces:**
- Consumes: `enrollNode` re-enrolment from Task 2; `adoptStations` from `src/services/station-registry`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append inside the same `describe` block:

```ts
  test("adopted stations survive a re-enrolment", async () => {
    // Identity is only worth persisting if what hangs off it persists too.
    // Stations key on nodeId, so keeping the id keeps the fleet's view intact —
    // this is the difference between "the runtime came back" and "the runtime
    // came back as itself".
    const runtimeId = await seedRuntime(TEST_USER_ID);
    const { token } = await mintEnrollmentToken(TEST_USER_ID, {
      provisionedRuntimeId: runtimeId,
    });
    const { nodeId } = await enrollNode(token, HOST_INFO);

    await adoptStations(TEST_USER_ID, nodeId, ["opencode:workspace"], [
      {
        key: "opencode:workspace", harness: "opencode", kind: "leaf",
        displayName: "workspace", parentKey: null, workspacePath: "/workspace",
        capabilities: ["health", "acp"], adopted: false,
      },
    ]);

    await enrollNode(token, HOST_INFO);

    const rows = await rawSql`
      SELECT station_key, capabilities FROM stations WHERE node_id = ${nodeId}
    ` as Array<{ station_key: string; capabilities: string[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.station_key).toBe("opencode:workspace");
  });
```

Add the import at the top of the file, beside the other service imports:

```ts
import { adoptStations } from "../../src/services/station-registry";
```

Add `stations` to the `afterAll` cleanup, deleted before `nodes` (stations reference nodes).

- [ ] **Step 2: Run it**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/enrollment.test.ts
```

Expected: PASS with Task 2 in place. Run it anyway — if it fails, re-enrolment is deleting or re-creating the node rather than updating it, which the row-count test in Task 2 would not necessarily catch.

- [ ] **Step 3: Commit**

```bash
git add apps/hub/tests/integration/enrollment.test.ts
git commit -m "test(hub): adopted stations survive a runtime re-enrolment"
```

---

## Task 4: Full verification and PR

- [ ] **Step 1: Run every suite**

```bash
cd packages/contract && bun test
cd ../../apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
cd ../node-agent && go vet ./... && go test -race ./...
cd ../console && pnpm check && pnpm test && pnpm build
```

Expected: all four green — the required checks on `main`.

- [ ] **Step 2: Verify live against the deployed hub**

Unit tests use a seeded runtime row. This exercises the deployed code against a runtime
created by the real provisioning path — the discipline that found #243 and the dead
Cloudflare worker.

Deploy the branch:

```bash
ssh root@178.105.68.68 'cd /opt/agentpod && git fetch -q origin runtime-identity-persistence && git checkout -q FETCH_HEAD && export PATH="$PATH:/root/.bun/bin" && pnpm install --frozen-lockfile >/dev/null 2>&1 && systemctl restart agentpod-hub && sleep 8 && systemctl is-active agentpod-hub'
```

Then provision a runtime and simulate the restart at the enrolment boundary. The raw
enrolment token is not recoverable after provisioning (only its hash is stored), so mint a
second runtime-bound token for the same runtime — which is exactly what re-presentation
looks like to the hub:

```bash
ssh root@178.105.68.68 'cd /opt/agentpod/apps/hub && set -a && . /etc/agentpod/hub.env && set +a && /root/.bun/bin/bun -e "
import { createRuntime } from \"./src/services/runtimes.ts\";
import { registerEnabledProvisioners } from \"./src/services/provisioner/bootstrap.ts\";
import { mintEnrollmentToken, enrollNode } from \"./src/services/enrollment.ts\";
import { db } from \"./src/db/drizzle.ts\";
registerEnabledProvisioners();
const u = (await db.query.user.findMany({ limit: 1 }))[0];
const rt = await createRuntime(u.id, { provider: \"docker\", name: \"identity-check\", resourceTier: \"small\", harness: \"opencode\" }, \"https://hub.agentpod.dev\");
await new Promise(r => setTimeout(r, 20000));
const before = (await db.query.provisionedRuntimes.findFirst({ where: (t,{eq}) => eq(t.id, rt.id) }));
const { token } = await mintEnrollmentToken(u.id, { provisionedRuntimeId: rt.id });
const again = await enrollNode(token, { hostname: \"identity-check\", os: \"linux\", arch: \"amd64\", cpuCount: 2 });
console.log(\"RESULT runtime=\" + rt.id + \" before=\" + before?.nodeId + \" after=\" + again.nodeId + \" same=\" + (before?.nodeId === again.nodeId));
process.exit(0);
"'
```

Expected: `same=true`. On `main` this would print two different node ids.

Clean up the runtime and its container afterwards, and return the hub to `main`.

> The full container-level test — kill the container, let it re-enrol on a fresh disk, confirm
> it returns as the same node — lands with the Cloudflare driver, where an ephemeral-disk
> restart is native. Docker preserves its writable layer across restarts, so it cannot
> reproduce the failure this fixes without artificially recreating the container.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin runtime-identity-persistence
gh pr create --title "feat: a restarted runtime keeps its node identity" --body "$(cat <<'EOF'
Implements `docs/superpowers/specs/2026-08-12-runtime-identity-persistence-design.md`.

A provisioned runtime that restarts currently becomes a **different node**. Its
identity lives on container disk; on an ephemeral-disk substrate a restart
destroys it, the entrypoint re-enrols, and `enrollNode` mints a brand new node —
orphaning the runtime's stations, capabilities and history.

Verified on a real Cloudflare container 2026-08-12: stopped, woken, restarted
cleanly, node never came back.

**Not Cloudflare-specific.** Any restart on any ephemeral-disk substrate —
eviction, redeploy, crash. Docker escapes it today only because container
restarts preserve the writable layer, which is a property of that substrate
rather than a guarantee of the design.

## The fix is smaller than the problem

No node-agent change: it is already idempotent (`decideEnroll`,
`enroll_idempotent_test.go`), and the schema already links tokens to runtimes via
`enrollment_tokens.provisionedRuntimeId`. The whole gap was that `enrollNode`
mints unconditionally.

Now, when a token's runtime already has a node, enrolment **returns that node
with a rotated secret**. Three properties fall out: identity survives, the secret
rotates on every restart, and nothing durable needs storing in the container.

## The trade, stated plainly

**Runtime-bound tokens become reusable and non-expiring.** That turns a one-shot
bearer credential into a durable one, which is exactly the kind of thing `apn
scan` exists to complain about. It is bounded three ways: it resolves to exactly
one runtime and can create nothing else, it is already in that container's
environment today, and destroying the runtime revokes it.

**Unbound tokens are unchanged** — strictly one-time, one-hour expiry — and a
test pins that, because it is the property this must not erode. The existing
atomic-consume TOCTOU protection is untouched on that path.

## Rejected deliberately

- **Substrate-side storage** (Durable Objects, R2) — would duplicate per driver.
- **Injecting the node secret as env** — a long-lived secret in a process listing.
- **Sleep/wake as a station state** — the spike showed containers can stay alive
  indefinitely, so scale-to-zero is a cost optimisation, not a prerequisite.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01EohapceVTgobwUGTQ5LuyW
EOF
)"
```

- [ ] **Step 4: Wait for the four required checks**

```bash
gh pr checks --watch
```

Expected: `contract`, `hub`, `node-agent`, `console` all green.
