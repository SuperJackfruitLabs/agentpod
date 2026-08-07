# Trustworthy Fleet Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the console's fleet state trustworthy under reconnects, hub restarts, and re-installs — and make the release pipeline degrade gracefully instead of bricking self-update.

**Architecture:** Hub-side connection lifecycle fixes (epoch guard, heartbeat re-register, boot reset, sweeper) in `gateway.ts`/`connection-manager.ts`/`node-registry.ts`; a self-healing enroll flow in the Go node-agent backed by one new public hub endpoint; a config/auth secret rename; CI YAML hardening. Spec: `docs/superpowers/specs/2026-08-07-trustworthy-fleet-slice-design.md`.

**Tech Stack:** Bun + Hono + Drizzle (hub), Go (node-agent), GitHub Actions.

## Global Constraints

- Branch: `develop`. Commit style: `fix(hub): …` / `fix(node-agent): …` / `ci(release-node-agent): …` (match `git log`).
- Hub tests: `cd apps/hub && bun test` (bun at `/opt/homebrew/bin/bun`). Integration tests need the local test postgres on `localhost:5434` — if `bun test` fails to connect, run `docker start agentpod-test-postgres` (Docker Desktop must be running).
- Node-agent tests: `cd apps/node-agent && go test -race ./...`
- Board workflow (GitHub Project #4 "AgentPod Redesign"): when starting an issue's first task set its card **In Progress**; when its last task lands, add a summary comment on the issue referencing the commit SHA(s), close the issue, set card **Done**. Issue mapping: Task 1 → #149, Tasks 2–4 → #47, Tasks 5–6 → #161, Task 7 → new issue (created in Task 7).
- Pre-existing known-red: `apps/hub` `tsc` errors in `stations.ts`/`routes/stations.ts` (AnyPgColumn import + `adopted` prop). These do NOT fail `bun test` — do not fix them in this slice, and do not treat them as your breakage.
- Heartbeat cadence facts (do not change): agent heartbeats every 15s; sweeper threshold 45s; sweep interval 15s.

---

### Task 1: Auth secret tidy-up (#149)

**Files:**
- Modify: `apps/hub/src/config.ts:119`
- Modify: `apps/hub/src/utils/validate-config.ts:46-55,94-99`
- Modify: `apps/hub/src/auth/drizzle-auth.ts` (the `betterAuth({...})` call at line 42)
- Modify: any `.env.example` / docs hits from the grep in Step 1

**Interfaces:**
- Consumes: `config.betterAuth.session.secret` (existing shape, kept).
- Produces: hub reads `BETTER_AUTH_SECRET` via `config.ts` and passes it explicitly to `betterAuth()`. No other task depends on this.

No new unit test: this is env plumbing with no seam — it is verified by the boot-time validator, the grep, and the existing suite staying green.

- [ ] **Step 1: Find every SESSION_SECRET reference**

Run: `grep -rn "SESSION_SECRET" apps/ docs/ --include="*.ts" --include="*.md" --include="*.example" -l`
Expected: `config.ts`, `validate-config.ts`, possibly `.env.example` and docs files. Every hit gets updated in Steps 2–4.

- [ ] **Step 2: Rename the env read in config.ts**

In `apps/hub/src/config.ts:119` replace:

```ts
      secret: getEnv('SESSION_SECRET', 'dev-session-secret-change-in-production'),
```

with:

```ts
      // Better Auth signing secret. Docs and prod env already use BETTER_AUTH_SECRET;
      // config is the single source of truth and passes it to betterAuth() explicitly.
      secret: getEnv('BETTER_AUTH_SECRET', 'dev-session-secret-change-in-production'),
```

- [ ] **Step 3: Update validate-config.ts field labels**

In `apps/hub/src/utils/validate-config.ts`, both error objects that say `field: "SESSION_SECRET"` (lines ~49 and ~96) become `field: "BETTER_AUTH_SECRET"`. Messages keep the `openssl rand -base64 32` hint. The `config.betterAuth.session.secret` reads stay as-is.

- [ ] **Step 4: Pass the secret into betterAuth()**

In `apps/hub/src/auth/drizzle-auth.ts`, inside `betterAuth({`, add directly after the `database:` block:

```ts
  // Explicit secret from config — do not rely on Better Auth's implicit
  // BETTER_AUTH_SECRET env read.
  secret: config.betterAuth.session.secret,
```

(`config` is already imported in that file — verify, and import from `../config` if not.) Update any `.env.example`/docs hits from Step 1 to name `BETTER_AUTH_SECRET`.

- [ ] **Step 5: Verify no stragglers + suite green**

Run: `grep -rn "SESSION_SECRET" apps/ docs/ --include="*.ts" --include="*.md" --include="*.example"`
Expected: no hits.
Run: `cd apps/hub && bun test`
Expected: all pass (same count as before the change).

- [ ] **Step 6: Commit**

```bash
git add -A apps/hub docs
git commit -m "fix(hub): read BETTER_AUTH_SECRET in config and pass it to betterAuth() (#149)"
```

Then: summary comment on #149 with the SHA, close it, card → Done.

---

### Task 2: Connection epoch guard + heartbeat re-register (#47a/#47b)

**Files:**
- Modify: `apps/hub/src/services/connection-manager.ts`
- Modify: `apps/hub/src/routes/gateway.ts`
- Test: `apps/hub/tests/unit/connection-manager.test.ts` (add cases)
- Test: `apps/hub/tests/integration/gateway.test.ts` (add cases)

**Interfaces:**
- Consumes: `connectionManager.register/unregister/isOnline/send` (existing).
- Produces: `isCurrent(nodeId: string, send: Send): boolean` on `NodeConnectionManager` — Task 4's sweeper does NOT need it, but gateway.ts onClose does. Gateway behavior later tasks rely on: a heartbeat from a socket with no registry entry re-registers that socket.

- [ ] **Step 1: Write the failing unit test for isCurrent**

Append to `apps/hub/tests/unit/connection-manager.test.ts` (match the file's existing import style):

```ts
test("isCurrent is true only for the currently registered send fn", () => {
  const cm = new InMemoryConnectionManager();
  const sendA = () => {};
  const sendB = () => {};
  cm.register("node_x", sendA);
  expect(cm.isCurrent("node_x", sendA)).toBe(true);
  expect(cm.isCurrent("node_x", sendB)).toBe(false);
  // A reconnect replaces the entry — the old socket is no longer current.
  cm.register("node_x", sendB);
  expect(cm.isCurrent("node_x", sendA)).toBe(false);
  expect(cm.isCurrent("node_x", sendB)).toBe(true);
  // Unregistered node: nothing is current.
  cm.unregister("node_x");
  expect(cm.isCurrent("node_x", sendB)).toBe(false);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`cm.isCurrent is not a function`)

Run: `cd apps/hub && bun test tests/unit/connection-manager.test.ts`

- [ ] **Step 3: Implement isCurrent**

In `apps/hub/src/services/connection-manager.ts` add to the interface:

```ts
  /** True when `send` is the currently registered sender for nodeId (epoch guard). */
  isCurrent(nodeId: string, send: Send): boolean;
```

and to `InMemoryConnectionManager`:

```ts
  isCurrent(nodeId: string, send: Send) {
    return this.conns.get(nodeId) === send;
  }
```

- [ ] **Step 4: Run unit test — expect PASS**

- [ ] **Step 5: Write the failing integration test for the reconnect race**

Append to `apps/hub/tests/integration/gateway.test.ts` (reuse the file's existing helpers/imports; also import `connectionManager` from `../../src/services/connection-manager`):

```ts
test("a late close from a replaced socket does not mark the reconnected node offline", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  try {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId, nodeSecret } = await enrollNode(token, {
      hostname: "race-host", os: "linux", arch: "amd64", cpuCount: 1,
    });
    const headers = { Authorization: `Bearer ${nodeId}:${nodeSecret}` };
    const url = `ws://localhost:${server.port}/public/nodes/gateway`;

    const wsOld = new WebSocket(url, { headers } as RequestInit & { headers: Record<string, string> });
    await new Promise<void>((res, rej) => { wsOld.onopen = () => res(); wsOld.onerror = () => rej(new Error("old socket failed")); });
    await new Promise((r) => setTimeout(r, 200));

    // Node reconnects on a new socket while the old one is still open.
    const wsNew = new WebSocket(url, { headers } as RequestInit & { headers: Record<string, string> });
    await new Promise<void>((res, rej) => { wsNew.onopen = () => res(); wsNew.onerror = () => rej(new Error("new socket failed")); });
    await new Promise((r) => setTimeout(r, 200));

    // The OLD socket closes late.
    wsOld.close();
    await new Promise((r) => setTimeout(r, 200));

    // Node must still be online, and the NEW socket must still be routable.
    const list = await listNodes(TEST_USER_ID);
    expect(list.find((n) => n.id === nodeId)?.status).toBe("online");
    const ackPromise = new Promise<unknown>((res) => { wsNew.onmessage = (e) => res(JSON.parse(String(e.data))); });
    wsNew.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
    expect(((await ackPromise) as { type: string }).type).toBe("ack");

    wsNew.close();
  } finally {
    server.stop(true);
  }
});

test("a heartbeat from a socket with no registry entry re-registers it", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  try {
    const { token } = await mintEnrollmentToken(TEST_USER_ID);
    const { nodeId, nodeSecret } = await enrollNode(token, {
      hostname: "rereg-host", os: "linux", arch: "amd64", cpuCount: 1,
    });
    const ws = new WebSocket(`ws://localhost:${server.port}/public/nodes/gateway`, {
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    } as RequestInit & { headers: Record<string, string> });
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("connect failed")); });
    await new Promise((r) => setTimeout(r, 200));

    // Simulate a sweep: the registry entry is gone but the socket is alive.
    connectionManager.unregister(nodeId);
    expect(connectionManager.isOnline(nodeId)).toBe(false);

    const ackPromise = new Promise<unknown>((res) => { ws.onmessage = (e) => res(JSON.parse(String(e.data))); });
    ws.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
    expect(((await ackPromise) as { type: string }).type).toBe("ack");
    // Server→node routing is restored, not just DB status.
    expect(connectionManager.isOnline(nodeId)).toBe(true);

    ws.close();
  } finally {
    server.stop(true);
  }
});
```

- [ ] **Step 6: Run integration tests — expect the first new test to FAIL** (node goes offline after the old socket closes), the second to FAIL on `isOnline` being false after heartbeat.

Run: `cd apps/hub && bun test tests/integration/gateway.test.ts`

- [ ] **Step 7: Implement the gateway changes**

In `apps/hub/src/routes/gateway.ts`:

(a) In the factory scope (next to `let authed`), add:

```ts
    // This connection's send fn — its identity is the connection epoch.
    let send: ((m: Parameters<typeof connectionManager.send>[1]) => void) | null = null;
```

(Simpler: `import type { Send } from "../services/connection-manager"` and declare `let send: Send | null = null;` — export `Send` is already there.)

(b) In `onOpen`, replace the inline arrow in `register` with the shared closure:

```ts
        send = (m) => ws.send(JSON.stringify(m));
        connectionManager.register(nodeId, send);
```

(c) In the heartbeat branch of `onMessage`, before `setNodeStatus`:

```ts
        } else if (parsed.data.type === "heartbeat") {
          // A heartbeating socket with no registry entry (swept, or lost to a
          // close race) re-registers itself — server→node send must work for
          // any node that is heartbeating. Never steal an existing entry.
          if (send && !connectionManager.isOnline(authed)) {
            connectionManager.register(authed, send);
          }
          await setNodeStatus(authed, "online");
          connectionManager.send(authed, { type: "ack", ts: Date.now() });
        }
```

(d) In `onClose`, guard the teardown on being the current epoch:

```ts
      async onClose() {
        resolveAuth(false); // unblock any onMessage awaiting auth on early close
        // Epoch guard: only the currently registered socket tears down. A late
        // close from a replaced socket must not mark the fresh connection
        // offline or drop its send entry.
        if (authed && send && connectionManager.isCurrent(authed, send)) {
          clearNode(authed); // flush health cache immediately on disconnect
          dropNode(authed);
          connectionManager.unregister(authed);
          await setNodeStatus(authed, "offline");
        }
      },
```

- [ ] **Step 8: Run the full hub suite — expect PASS**

Run: `cd apps/hub && bun test`

- [ ] **Step 9: Commit**

```bash
git add apps/hub/src/services/connection-manager.ts apps/hub/src/routes/gateway.ts apps/hub/tests
git commit -m "fix(hub): epoch-guard gateway close + heartbeat re-registers dropped sockets (#47)"
```

(#47 stays open — Tasks 3–4 continue it. Card → In Progress if not already.)

---

### Task 3: Startup reconciliation + lastSeenAt honesty (#47c/#47e)

**Files:**
- Modify: `apps/hub/src/services/node-registry.ts`
- Modify: `apps/hub/src/index.ts` (after `await initDatabase()`)
- Test: `apps/hub/tests/integration/node-reconciliation.test.ts` (create)

**Interfaces:**
- Consumes: `setNodeStatus` (modified here), drizzle `db`, `nodes` schema.
- Produces: `resetOrphanedOnlineNodes(): Promise<number>` in `node-registry.ts` (returns count of rows flipped) — called from `index.ts` at boot; Task 4's test file shares the new test file's setup.

- [ ] **Step 1: Write the failing integration test**

Create `apps/hub/tests/integration/node-reconciliation.test.ts`:

```ts
/**
 * Integration: startup reconciliation + lastSeenAt honesty + heartbeat sweeper.
 * Uses the local Docker test-postgres (agentpod-test-postgres on localhost:5434).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { rawSql } from "../../src/db/drizzle";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import {
  listNodes,
  setNodeStatus,
  resetOrphanedOnlineNodes,
} from "../../src/services/node-registry";

const TEST_USER_ID = "test-user-reconcile-001";

async function makeNode(hostname: string): Promise<string> {
  const { token } = await mintEnrollmentToken(TEST_USER_ID);
  const { nodeId } = await enrollNode(token, {
    hostname, os: "linux", arch: "amd64", cpuCount: 1,
  });
  return nodeId;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER_ID,
    email: "reconcile-test@example.com",
    name: "Reconcile Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM "user"            WHERE id      = ${TEST_USER_ID}`;
  } catch {
    // Ignore cleanup errors
  }
});

test("resetOrphanedOnlineNodes flips online rows to offline at boot", async () => {
  const nodeId = await makeNode("boot-orphan-host");
  await setNodeStatus(nodeId, "online");

  const flipped = await resetOrphanedOnlineNodes();
  expect(flipped).toBeGreaterThanOrEqual(1);

  const node = (await listNodes(TEST_USER_ID)).find((n) => n.id === nodeId);
  expect(node?.status).toBe("offline");
});

test("setNodeStatus offline does not bump lastSeenAt", async () => {
  const nodeId = await makeNode("lastseen-host");
  await setNodeStatus(nodeId, "online");
  const seenOnline = (await listNodes(TEST_USER_ID)).find((n) => n.id === nodeId)!.lastSeenAt;
  expect(seenOnline).not.toBeNull();

  await new Promise((r) => setTimeout(r, 50));
  await setNodeStatus(nodeId, "offline");
  const seenOffline = (await listNodes(TEST_USER_ID)).find((n) => n.id === nodeId)!.lastSeenAt;
  // "last seen" means last actual contact — an offline transition is not contact.
  expect(seenOffline).toBe(seenOnline);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`resetOrphanedOnlineNodes` not exported; lastSeenAt bumped on offline)

Run: `cd apps/hub && bun test tests/integration/node-reconciliation.test.ts`

- [ ] **Step 3: Implement in node-registry.ts**

Replace `setNodeStatus` and add the reset function:

```ts
export async function setNodeStatus(
  nodeId: string,
  status: "online" | "offline"
) {
  // lastSeenAt means "last actual contact" — only online transitions bump it.
  await db
    .update(nodes)
    .set(status === "online" ? { status, lastSeenAt: new Date() } : { status })
    .where(eq(nodes.id, nodeId));
}

/**
 * Boot-time reconciliation: any row still marked online is an orphan from a
 * previous hub process (no socket can exist yet). Returns the flipped count.
 */
export async function resetOrphanedOnlineNodes(): Promise<number> {
  const rows = await db
    .update(nodes)
    .set({ status: "offline" })
    .where(eq(nodes.status, "online"))
    .returning({ id: nodes.id });
  return rows.length;
}
```

- [ ] **Step 4: Run the test — expect PASS**

- [ ] **Step 5: Wire into boot**

In `apps/hub/src/index.ts`, directly after `await initDatabase();`:

```ts
import { resetOrphanedOnlineNodes } from './services/node-registry.ts';
```

(import at top with the others), then:

```ts
const orphans = await resetOrphanedOnlineNodes();
if (orphans > 0) console.log(`Reset ${orphans} orphaned online node(s) to offline`);
```

- [ ] **Step 6: Full hub suite — expect PASS**

Run: `cd apps/hub && bun test`

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/services/node-registry.ts apps/hub/src/index.ts apps/hub/tests/integration/node-reconciliation.test.ts
git commit -m "fix(hub): reset orphaned online nodes at boot; lastSeenAt only on contact (#47)"
```

---

### Task 4: Heartbeat sweeper (#47d)

**Files:**
- Create: `apps/hub/src/services/node-sweeper.ts`
- Modify: `apps/hub/src/index.ts`
- Test: `apps/hub/tests/integration/node-reconciliation.test.ts` (extend)

**Interfaces:**
- Consumes: `setNodeStatus` (Task 3 semantics), `connectionManager.unregister`, `dropNode` (broker), `clearNode` (health-cache), drizzle `db` + `nodes`.
- Produces: `sweepStaleNodes(now?: number): Promise<string[]>` (returns swept nodeIds) and `startNodeSweeper(): () => void` (returns a stop fn). Constants `SWEEP_INTERVAL_MS = 15_000`, `OFFLINE_THRESHOLD_MS = 45_000` exported for tests/docs.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/tests/integration/node-reconciliation.test.ts`:

```ts
import { sweepStaleNodes, OFFLINE_THRESHOLD_MS } from "../../src/services/node-sweeper";

test("sweeper expires online nodes silent past the threshold — and not before", async () => {
  const staleId = await makeNode("sweep-stale-host");
  const freshId = await makeNode("sweep-fresh-host");
  await setNodeStatus(staleId, "online");
  await setNodeStatus(freshId, "online");

  // Age the stale node's lastSeenAt past the threshold.
  const past = new Date(Date.now() - OFFLINE_THRESHOLD_MS - 1000);
  await rawSql`UPDATE nodes SET last_seen_at = ${past} WHERE id = ${staleId}`;

  const swept = await sweepStaleNodes();
  expect(swept).toContain(staleId);
  expect(swept).not.toContain(freshId);

  const list = await listNodes(TEST_USER_ID);
  expect(list.find((n) => n.id === staleId)?.status).toBe("offline");
  expect(list.find((n) => n.id === freshId)?.status).toBe("online");
});

test("sweeper treats online rows with NULL lastSeenAt as stale", async () => {
  const nodeId = await makeNode("sweep-null-host");
  await setNodeStatus(nodeId, "online");
  await rawSql`UPDATE nodes SET last_seen_at = NULL WHERE id = ${nodeId}`;

  const swept = await sweepStaleNodes();
  expect(swept).toContain(nodeId);
});
```

- [ ] **Step 2: Run it — expect FAIL** (module not found)

Run: `cd apps/hub && bun test tests/integration/node-reconciliation.test.ts`

- [ ] **Step 3: Implement node-sweeper.ts**

Create `apps/hub/src/services/node-sweeper.ts`:

```ts
/**
 * Heartbeat sweeper — expires nodes whose TCP close never fired.
 *
 * Agents heartbeat every 15s. A node still marked online whose lastSeenAt is
 * older than OFFLINE_THRESHOLD_MS (3 missed heartbeats) gets the same full
 * teardown as a real close. False positives self-correct: a live socket's
 * next heartbeat re-registers it (gateway.ts heartbeat branch).
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import { connectionManager } from "./connection-manager";
import { dropNode } from "./broker";
import { clearNode } from "./health-cache";
import { setNodeStatus } from "./node-registry";

export const SWEEP_INTERVAL_MS = 15_000;
export const OFFLINE_THRESHOLD_MS = 45_000;

/** One sweep pass. Returns the nodeIds expired. Injectable `now` for tests. */
export async function sweepStaleNodes(now: number = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - OFFLINE_THRESHOLD_MS);
  const stale = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.status, "online"),
        or(isNull(nodes.lastSeenAt), lt(nodes.lastSeenAt, cutoff))
      )
    );

  for (const { id } of stale) {
    clearNode(id);
    dropNode(id);
    connectionManager.unregister(id);
    await setNodeStatus(id, "offline");
    console.log(`[sweeper] expired silent node ${id}`);
  }
  return stale.map((s) => s.id);
}

/** Start the periodic sweeper. Returns a stop function. */
export function startNodeSweeper(): () => void {
  const timer = setInterval(() => {
    void sweepStaleNodes().catch((err) =>
      console.error("[sweeper] sweep failed:", err)
    );
  }, SWEEP_INTERVAL_MS);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run the test — expect PASS**

- [ ] **Step 5: Wire into index.ts**

In `apps/hub/src/index.ts`, next to the provisioner bootstrap (after `registerEnabledProvisioners()`):

```ts
import { startNodeSweeper } from './services/node-sweeper.ts';
```

(import at top), then:

```ts
// Expire silent nodes whose TCP close never fired (killed VM, dropped network).
startNodeSweeper();
console.log('Node heartbeat sweeper started (45s threshold)');
```

- [ ] **Step 6: Full hub suite — expect PASS**

Run: `cd apps/hub && bun test`
Note: the sweeper only starts via `index.ts` boot, so tests that import routes directly are unaffected by the interval.

- [ ] **Step 7: Commit + close #47**

```bash
git add apps/hub/src/services/node-sweeper.ts apps/hub/src/index.ts apps/hub/tests/integration/node-reconciliation.test.ts
git commit -m "fix(hub): heartbeat-timeout sweeper expires silent nodes (#47)"
```

Then: summary comment on #47 listing the Task 2–4 SHAs, close it, card → Done.

---

### Task 5: Hub credential-check endpoint (#161, hub half)

**Files:**
- Modify: `apps/hub/src/routes/nodes.ts` (the `nodeEnrollRoutes` router)
- Test: `apps/hub/tests/integration/enrollment.test.ts` (extend)

**Interfaces:**
- Consumes: `verifyNodeCredential(nodeId, nodeSecret)` from `services/enrollment.ts`.
- Produces: `GET /public/nodes/credential-check` — `Authorization: Bearer <nodeId>:<nodeSecret>`; 200 `{"valid":true}` or 401 `{"valid":false}`. Task 6's Go client calls exactly this.

- [ ] **Step 1: Write the failing integration test**

Append to `apps/hub/tests/integration/enrollment.test.ts` (reuse its existing app/user setup; if the file tests via `app.request`, follow that pattern — the route is plain HTTP, no WS needed). Adapt names to the file's local helpers:

```ts
test("credential-check returns 200 for a valid node credential", async () => {
  const { token } = await mintEnrollmentToken(TEST_USER_ID);
  const { nodeId, nodeSecret } = await enrollNode(token, {
    hostname: "credcheck-host", os: "linux", arch: "amd64", cpuCount: 1,
  });
  const res = await testApp.request("/public/nodes/credential-check", {
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ valid: true });
});

test("credential-check returns 401 for a wrong secret and for a missing header", async () => {
  const { token } = await mintEnrollmentToken(TEST_USER_ID);
  const { nodeId } = await enrollNode(token, {
    hostname: "credcheck-bad-host", os: "linux", arch: "amd64", cpuCount: 1,
  });
  const bad = await testApp.request("/public/nodes/credential-check", {
    headers: { Authorization: `Bearer ${nodeId}:wrong-secret` },
  });
  expect(bad.status).toBe(401);
  const missing = await testApp.request("/public/nodes/credential-check");
  expect(missing.status).toBe(401);
});
```

(If `enrollment.test.ts` has no `testApp`, build one at the top of the new tests exactly like `gateway.test.ts` does: `const testApp = new Hono().route("/public/nodes", nodeEnrollRoutes);`.)

- [ ] **Step 2: Run it — expect FAIL** (404)

Run: `cd apps/hub && bun test tests/integration/enrollment.test.ts`

- [ ] **Step 3: Implement the route**

In `apps/hub/src/routes/nodes.ts`, chain onto `nodeEnrollRoutes` (same router that owns `POST /enroll`):

```ts
  // Node-side credential probe (self-healing re-enroll, #161).
  // Auth: Authorization: Bearer <nodeId>:<nodeSecret> — same scheme as the gateway.
  // 200 {valid:true} when the stored credential is still valid on this hub;
  // 401 {valid:false} otherwise. No state change.
  .get("/credential-check", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/, "");
    const idx = token.indexOf(":");
    const nodeId = idx !== -1 ? token.slice(0, idx) : "";
    const nodeSecret = idx !== -1 ? token.slice(idx + 1) : "";
    if (!nodeId || !nodeSecret || !(await verifyNodeCredential(nodeId, nodeSecret))) {
      return c.json({ valid: false }, 401);
    }
    return c.json({ valid: true });
  })
```

(`verifyNodeCredential` — import from `../services/enrollment` if the file doesn't already.)

- [ ] **Step 4: Run the test — expect PASS**, then full suite: `cd apps/hub && bun test`

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/routes/nodes.ts apps/hub/tests/integration/enrollment.test.ts
git commit -m "feat(hub): GET /public/nodes/credential-check for node re-enroll probe (#161)"
```

(#161 stays open — Task 6 finishes it.)

---

### Task 6: Agent self-healing enroll flow (#161, agent half)

**Files:**
- Modify: `apps/node-agent/internal/enroll/enroll.go`
- Create: `apps/node-agent/cmd/agentpod-node/enrollflow.go`
- Modify: `apps/node-agent/cmd/agentpod-node/main.go` (the `case "enroll":` block)
- Test: `apps/node-agent/internal/enroll/enroll_test.go` (extend)
- Test: `apps/node-agent/cmd/agentpod-node/enrollflow_test.go` (create)

**Interfaces:**
- Consumes: `GET /public/nodes/credential-check` (Task 5), `config.Load/Save/DefaultPath`, `enroll.Enroll`, `resolveEnrollArgs`, `alreadyEnrolled` (all existing).
- Produces: `enroll.CheckCredential(hubURL, nodeID, nodeSecret string) (bool, error)`; `decideEnroll(cfg config.Config, haveConfig bool, hub string, force bool, checkCred func(hub, id, secret string) (bool, error)) (enrollDecision, string)` with `decisionKeep | decisionEnroll | decisionKeepUnverified`; `enroll --force` flag. Container entrypoints keep working unchanged (`enroll && run` stays idempotent).

- [ ] **Step 1: Write the failing test for CheckCredential**

Append to `apps/node-agent/internal/enroll/enroll_test.go` (match its existing httptest style):

```go
func TestCheckCredential(t *testing.T) {
  t.Run("200 means valid", func(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
      if r.URL.Path != "/public/nodes/credential-check" { t.Errorf("path = %s", r.URL.Path) }
      if got := r.Header.Get("Authorization"); got != "Bearer node_1:sec" { t.Errorf("auth = %s", got) }
      w.WriteHeader(200)
    }))
    defer srv.Close()
    valid, err := CheckCredential(srv.URL, "node_1", "sec")
    if err != nil { t.Fatal(err) }
    if !valid { t.Fatal("want valid") }
  })
  t.Run("401 means invalid, not an error", func(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
      w.WriteHeader(401)
    }))
    defer srv.Close()
    valid, err := CheckCredential(srv.URL, "node_1", "sec")
    if err != nil { t.Fatal(err) }
    if valid { t.Fatal("want invalid") }
  })
  t.Run("5xx is an error", func(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
      w.WriteHeader(500)
    }))
    defer srv.Close()
    if _, err := CheckCredential(srv.URL, "node_1", "sec"); err == nil { t.Fatal("want error") }
  })
  t.Run("unreachable hub is an error", func(t *testing.T) {
    if _, err := CheckCredential("http://127.0.0.1:1", "node_1", "sec"); err == nil { t.Fatal("want error") }
  })
}
```

- [ ] **Step 2: Run — expect FAIL** (`undefined: CheckCredential`)

Run: `cd apps/node-agent && go test ./internal/enroll/`

- [ ] **Step 3: Implement CheckCredential**

Append to `apps/node-agent/internal/enroll/enroll.go`:

```go
// CheckCredential asks the hub whether nodeID:nodeSecret is still a valid
// identity there. (true, nil) on 200; (false, nil) on 401/403; error on
// anything else (network failure, 5xx) so callers can distinguish "hub said
// no" from "could not ask" — the latter must never destroy a stored identity.
func CheckCredential(hubURL, nodeID, nodeSecret string) (bool, error) {
  req, err := http.NewRequest("GET", hubURL+"/public/nodes/credential-check", nil)
  if err != nil { return false, err }
  req.Header.Set("Authorization", "Bearer "+nodeID+":"+nodeSecret)
  r, err := http.DefaultClient.Do(req)
  if err != nil { return false, err }
  defer r.Body.Close()
  switch r.StatusCode {
  case 200: return true, nil
  case 401, 403: return false, nil
  default: return false, fmt.Errorf("credential-check: unexpected status %d", r.StatusCode)
  }
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Write the failing table test for decideEnroll**

Create `apps/node-agent/cmd/agentpod-node/enrollflow_test.go`:

```go
package main

import (
  "errors"
  "testing"

  "github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

func TestDecideEnroll(t *testing.T) {
  cfg := config.Config{Hub: "https://hub", NodeID: "node_1", NodeSecret: "s"}
  valid := func(h, i, s string) (bool, error) { return true, nil }
  rejected := func(h, i, s string) (bool, error) { return false, nil }
  down := func(h, i, s string) (bool, error) { return false, errors.New("connection refused") }

  cases := []struct {
    name       string
    cfg        config.Config
    haveConfig bool
    hub        string
    force      bool
    check      func(h, i, s string) (bool, error)
    want       enrollDecision
  }{
    {"no existing config enrolls", config.Config{}, false, "https://hub", false, valid, decisionEnroll},
    {"force always re-enrolls", cfg, true, "https://hub", true, valid, decisionEnroll},
    {"hub mismatch re-enrolls", cfg, true, "https://other-hub", false, valid, decisionEnroll},
    {"valid credential on same hub keeps config", cfg, true, "https://hub", false, valid, decisionKeep},
    {"rejected credential re-enrolls", cfg, true, "https://hub", false, rejected, decisionEnroll},
    {"unreachable hub keeps config unverified", cfg, true, "https://hub", false, down, decisionKeepUnverified},
  }
  for _, tc := range cases {
    t.Run(tc.name, func(t *testing.T) {
      got, reason := decideEnroll(tc.cfg, tc.haveConfig, tc.hub, tc.force, tc.check)
      if got != tc.want { t.Fatalf("decision = %v (%s), want %v", got, reason, tc.want) }
      if reason == "" { t.Fatal("reason must be non-empty") }
    })
  }
}
```

- [ ] **Step 6: Run — expect FAIL** (`undefined: decideEnroll`)

Run: `cd apps/node-agent && go test ./cmd/agentpod-node/`

- [ ] **Step 7: Implement decideEnroll**

Create `apps/node-agent/cmd/agentpod-node/enrollflow.go`:

```go
package main

import (
  "fmt"

  "github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

// enrollDecision is the outcome of the self-healing enroll flow (#161).
type enrollDecision int

const (
  decisionKeep           enrollDecision = iota // valid config on this hub — idempotent no-op
  decisionEnroll                               // enroll with the provided token
  decisionKeepUnverified                       // hub unreachable — keep config, warn, exit 0
)

// decideEnroll implements the spec's decision flow: force > hub-mismatch >
// credential-check. checkCred is injected for tests (enroll.CheckCredential
// in production). Never destroys a stored identity it could not verify.
func decideEnroll(cfg config.Config, haveConfig bool, hub string, force bool,
  checkCred func(hub, id, secret string) (bool, error)) (enrollDecision, string) {
  if !haveConfig {
    return decisionEnroll, "no existing config"
  }
  if force {
    return decisionEnroll, "--force"
  }
  if cfg.Hub != hub {
    return decisionEnroll, fmt.Sprintf("hub changed (%s → %s)", cfg.Hub, hub)
  }
  valid, err := checkCred(hub, cfg.NodeID, cfg.NodeSecret)
  if err != nil {
    return decisionKeepUnverified, "hub unreachable: " + err.Error()
  }
  if valid {
    return decisionKeep, "credential verified"
  }
  return decisionEnroll, "stored credential rejected by hub"
}
```

- [ ] **Step 8: Run — expect PASS**

- [ ] **Step 9: Rewire main.go's enroll case**

Replace the entire `case "enroll":` block in `apps/node-agent/cmd/agentpod-node/main.go` with:

```go
  case "enroll":
    fs := flag.NewFlagSet("enroll", flag.ExitOnError)
    flagHub := fs.String("hub", "", "hub base URL")
    flagToken := fs.String("token", "", "enrollment token")
    flagForce := fs.Bool("force", false, "re-enroll even when a valid config exists")
    fs.Parse(os.Args[2:])
    existing, loadErr := config.Load(config.DefaultPath())
    haveConfig := alreadyEnrolled(existing, loadErr)
    hub, token, err := resolveEnrollArgs(*flagHub, *flagToken, os.Getenv)
    if err != nil {
      // Bare `enroll` on an already-enrolled machine stays a friendly no-op.
      if haveConfig { fmt.Println("already enrolled:", existing.NodeID); return }
      fmt.Fprintln(os.Stderr, err); os.Exit(1)
    }
    decision, reason := decideEnroll(existing, haveConfig, hub, *flagForce, enroll.CheckCredential)
    switch decision {
    case decisionKeep:
      fmt.Printf("already enrolled: %s (%s)\n", existing.NodeID, reason)
      return
    case decisionKeepUnverified:
      // Keep a possibly-valid identity; `run` retries connecting anyway.
      fmt.Fprintf(os.Stderr, "warning: keeping existing config (%s)\n", reason)
      return
    }
    if haveConfig { fmt.Printf("re-enrolling: %s\n", reason) }
    id, sec, err := enroll.Enroll(hub, token, host.Info())
    if err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
    // Preserve operator-set lifecycle commands across re-enrollment.
    newCfg := config.Config{Hub: hub, NodeID: id, NodeSecret: sec,
      HermesStartCmd: existing.HermesStartCmd, OpenClawStartCmd: existing.OpenClawStartCmd}
    if err := config.Save(config.DefaultPath(), newCfg); err != nil {
      fmt.Fprintln(os.Stderr, err); os.Exit(1)
    }
    fmt.Println("enrolled:", id)
```

(The old top-of-case idempotency guard is deleted — `decisionKeep` replaces it. `alreadyEnrolled` and its tests stay.)

- [ ] **Step 10: Full node-agent suite — expect PASS**

Run: `cd apps/node-agent && go test -race ./...`
If `enroll_idempotent_test.go` asserted the OLD bare-guard behavior (skip without any network call even when hub+token given), update it to the new contract: with hub+token given and a stub hub returning 200, output is `already enrolled: <id> (credential verified)` and the token is NOT consumed.

- [ ] **Step 11: Commit + close #161**

```bash
git add apps/node-agent
git commit -m "feat(node-agent): self-healing enroll — verify stored credential, --force flag (#161)"
```

Then: summary comment on #161 with Task 5+6 SHAs, close it, card → Done.

---

### Task 7: Release pipeline hardening (CI)

**Files:**
- Modify: `.github/workflows/release-node-agent.yml`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a release workflow where (a) asset uploads retry 3× via `gh`, (b) `static-assets` and `sha256sums` run under `if: ${{ !cancelled() }}` so a failed arch no longer skips SHA256SUMS. Task 8's `v0.1.10` tag is the live verification.

- [ ] **Step 1: File the issue + board card**

```bash
gh issue create --repo rakeshgangwar/agentpod \
  --title "release-node-agent: retry uploads + decouple SHA256SUMS from all-arch success" \
  --body "fail-fast:false (ca5b504) stopped sibling-arch cancellation, but a genuinely failed arch still fails the needs:build gate and SKIPS SHA256SUMS/static-assets — and without SHA256SUMS no node can verify a self-update (seen on v0.1.4/v0.1.7; remediation was gh run rerun --failed). Harden: (1) retry the flake-prone upload steps 3x via gh; (2) run static-assets + sha256sums with if:!cancelled() computing sums over whatever binaries reached the release, so a hard arch failure degrades to that-arch-cant-update instead of fleet-wide. Workflow still reports red on a missing arch. Spec: docs/superpowers/specs/2026-08-07-trustworthy-fleet-slice-design.md" \
  --label "redesign,follow-up"
```

Add the issue to Project #4, card → In Progress. Note the issue number `<N>` for the commit.

- [ ] **Step 2: Replace the build job's upload step**

In `.github/workflows/release-node-agent.yml`, replace the `Upload binary to release` step (the `softprops/action-gh-release@v2` block in the `build` job) with:

```yaml
      - name: Upload binary to release (retry x3)
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.ref_name || inputs.tag }}
        working-directory: apps/node-agent
        run: |
          # Create the release once (first arch to get here wins; races are benign).
          gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1 || \
            gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --title "$TAG" --generate-notes || true
          ok=0
          for i in 1 2 3; do
            if gh release upload "$TAG" "agentpod-node-${{ matrix.goos }}-${{ matrix.goarch }}" \
                --repo "$GITHUB_REPOSITORY" --clobber; then
              ok=1; break
            fi
            echo "upload attempt $i failed; retrying in $((i * 10))s"
            sleep $((i * 10))
          done
          [ "$ok" = 1 ]
```

- [ ] **Step 3: Harden static-assets**

Replace the `static-assets` job with (note `if:` and the `gh` upload with retry — release creation is guarded the same way in case every build job failed before creating it):

```yaml
  static-assets:
    name: Upload static release assets
    runs-on: ubuntu-latest
    needs: build
    # Run even when an arch failed — a partial release must still carry
    # install.sh/.service (and sha256sums below needs this job).
    if: ${{ !cancelled() }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Upload static assets to release (retry x3)
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.ref_name || inputs.tag }}
        run: |
          gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1 || \
            gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --title "$TAG" --generate-notes || true
          ok=0
          for i in 1 2 3; do
            if gh release upload "$TAG" \
                apps/node-agent/deploy/agentpod-node.service \
                apps/node-agent/scripts/install.sh \
                --repo "$GITHUB_REPOSITORY" --clobber; then
              ok=1; break
            fi
            echo "upload attempt $i failed; retrying in $((i * 10))s"
            sleep $((i * 10))
          done
          [ "$ok" = 1 ]
```

- [ ] **Step 4: Harden sha256sums**

In the `sha256sums` job: add `if: ${{ !cancelled() }}` under `needs: static-assets`, and replace its final `softprops/action-gh-release@v2` upload step with:

```yaml
      - name: Upload SHA256SUMS to release (retry x3)
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.ref_name || inputs.tag }}
        run: |
          ok=0
          for i in 1 2 3; do
            if gh release upload "$TAG" release-assets/SHA256SUMS \
                --repo "$GITHUB_REPOSITORY" --clobber; then
              ok=1; break
            fi
            echo "upload attempt $i failed; retrying in $((i * 10))s"
            sleep $((i * 10))
          done
          [ "$ok" = 1 ]
```

The existing `Download all release assets` + `Compute SHA256SUMS` steps stay — `gh release download` naturally picks up whatever subset of binaries made it. Also set `GH_TOKEN` and `TAG` the same way on the download step if it currently interpolates the tag inline (it does — leave its `TAG="${{ github.ref_name || inputs.tag }}"` line as-is, it's fine).

- [ ] **Step 5: Sanity-check the YAML**

Run: `bunx yaml-lint .github/workflows/release-node-agent.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release-node-agent.yml')); print('yaml ok')"`
Expected: `yaml ok` (or lint pass). Full behavioral verification happens on the `v0.1.10` tag in Task 8 — say so honestly in the issue comment; don't claim CI-verified before then.

- [ ] **Step 6: Commit + close the issue**

```bash
git add .github/workflows/release-node-agent.yml
git commit -m "ci(release-node-agent): retry uploads; SHA256SUMS survives a failed arch (#<N>)"
```

Summary comment on #<N> with the SHA (note: live-verified at v0.1.10), close, card → Done.

---

### Task 8: Integration, release v0.1.10, deploy, live verify

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above. Produces: v0.1.10 live on the fleet.

- [ ] **Step 1: Full verification sweep**

```bash
cd apps/hub && bun test
cd ../node-agent && go test -race ./...
cd ../console && pnpm check && pnpm test && pnpm build
```

Expected: all green (console is untouched — this guards against accidental contract drift). Remember the pre-existing `stations.ts` tsc redness is out of scope.

- [ ] **Step 2: CHANGELOG entry**

Add a `## v0.1.10` section to `CHANGELOG.md` summarizing: epoch-guarded gateway close, heartbeat re-register, boot reset, 45s heartbeat sweeper (#47); self-healing re-enroll + `enroll --force` + `/public/nodes/credential-check` (#161); `BETTER_AUTH_SECRET` config tidy (#149); release-pipeline retry + decoupled SHA256SUMS. Commit: `git add CHANGELOG.md && git commit -m "docs: changelog for v0.1.10"`.

- [ ] **Step 3: PR develop → main + merge**

```bash
git push origin develop
gh pr create --repo rakeshgangwar/agentpod --base main --head develop \
  --title "v0.1.10: trustworthy fleet (reconciliation, self-healing enroll, auth secret, CI hardening)" \
  --body "$(cat <<'EOF'
Ships the trustworthy-fleet slice: #47 #161 #149 + release hardening.
Spec: docs/superpowers/specs/2026-08-07-trustworthy-fleet-slice-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Wait for the four required checks (`contract`, `hub`, `node-agent`, `console`), then merge (regular merge, as PR #185 was).

- [ ] **Step 4: Deploy hub to the VPS**

```bash
ssh root@178.105.68.68 'cd /opt/agentpod && git fetch origin main && git merge --ff-only FETCH_HEAD && systemctl restart agentpod-hub && journalctl -u agentpod-hub -n 20 --no-pager'
```

(`git pull` under-shoots on this box — its `origin/main` tracking ref is stale; fetch+merge FETCH_HEAD, per the known quirk.) Expected in the log: `Reset N orphaned online node(s)` (or 0), `Node heartbeat sweeper started`, `Configuration validation passed`.

- [ ] **Step 5: Tag v0.1.10 and watch the hardened release workflow**

```bash
git checkout main && git pull
git tag v0.1.10 && git push origin v0.1.10
gh run watch --repo rakeshgangwar/agentpod $(gh run list --repo rakeshgangwar/agentpod --workflow release-node-agent.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: 4 binaries + install.sh + .service + SHA256SUMS on the release. If an arch flakes even through retries: the SUMS must still publish (that's the point) — then `gh run rerun --failed` for the missing arch.

- [ ] **Step 6: Roll the fleet + live verify**

1. Console (console.agentpod.dev): both nodes show `update: v0.1.9 → v0.1.10`; click UPDATE on each; expect honest `ok:true`, nodes reconnect on v0.1.10.
2. **#47 live check:** during each node's self-update restart, the node flips offline (sweeper/close) and back online on reconnect — no ghost states. Then `ssh root@178.105.68.68 'systemctl restart agentpod-hub'` and confirm both nodes are offline immediately after boot (startup reset), then online again within ~30s (reconnect) — watch `/nodes`.
3. **#161 live check (the original repro):** on this Mac (which has a stale config from the pre-wipe era), mint a token in the console, run the curl-install one-liner — expect `re-enrolling: stored credential rejected by hub` (or hub-mismatch) and the Mac appearing online in the fleet, NOT `already enrolled` + silence. Afterwards remove the Mac node again if unwanted (console → node delete), and clean the 2 stale offline "Rakeshs-MacBook-Pro" rows if still present.
4. **#149 live check:** hub booted with `Configuration validation passed` (Step 4 log) — done.

- [ ] **Step 7: Wrap up**

Verify all four issues closed with summary comments + Done cards. Report results (including anything that did NOT go as expected) honestly.
