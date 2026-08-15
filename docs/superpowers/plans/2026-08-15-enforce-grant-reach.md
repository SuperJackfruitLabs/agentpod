# Enforce `mayGrantReach` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `mayGrantReach` a control that runs — refuse the acts that change what an agent *is* (workspace writes, terminal, destructive cleanup, fleet growth) to principals who do not hold it.

**Architecture:** A classification of station capabilities, typed `Record<Capability, boolean>` so a new capability breaks the build until someone classifies it, plus two guard functions that combine the boolean with the *existing* dispatch scope matcher. Guards are called beside the existing `gateCapability` checks — never folded into it, because two of its five callers are reads. Refusals reuse the pair's denial vocabulary: 403 on HTTP, close 1008 on the terminal WS, audited as well as logged.

**Tech Stack:** Bun + Hono + Drizzle/Postgres (hub), SvelteKit 5 runes (console), zod contract package.

**Spec:** `docs/superpowers/specs/2026-08-15-granting-reach-design.md`

## Global Constraints

- **The switch is `ENFORCE_CONTROL_PAIR === "true"`** (literal lowercase). No new flag. When it is off, every guard added here is a no-op.
- **Composition rule:** a station-scoped act requires `mayGrantReach === true` **and** a `mayDispatch` value matching that station. A fleet-level act requires `mayGrantReach === true` **and** at least one `agentpod:` value whose node half is exactly `*`.
- **Reach-bearing capabilities:** `fs.write`, `terminal`, `cleanup`. Everything else in the contract enum is open: `changeset`, `lifecycle`, `acp`, `inventory`, `health`, `logs`, `fs.read`.
- **Effect matters:** the guard fires only for `effect: "mutate"`. `cleanup/plan` is a read and stays open; `cleanup/apply` mutates and is guarded.
- **Reads are never guarded.** Observation is not reach.
- **Hub tests** need `DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod"` and a pgvector Postgres on :5434.
- **Console tests** run under Node 22 (`nvm use 22`); Node 26 fails jsdom in ways that look like broken code.
- **TDD:** failing test first, every task.

### Deviation from the spec, and why

The spec put the guards in `services/control-pair.ts`. That file's own docstring says it holds "the part that is neither storage nor policy: whether the control runs at all, and what a refusal *is*" — and the guards are policy plus two database reads. So:

- `services/control-pair.ts` gains **only** the error type (`GrantReachDenied`) and its type guard.
- `services/grant-reach.ts` (new) holds the classification table and the two guard functions.

Nothing else about the spec changes.

---

### Task 1: The classification and the guards

**Files:**
- Modify: `apps/hub/src/services/control-pair.ts` (append the error type)
- Create: `apps/hub/src/services/grant-reach.ts`
- Test: `apps/hub/tests/integration/grant-reach.test.ts`

**Interfaces:**
- Consumes: `getGrant`, `grantAllowsStation`, `AGENTPOD_NS` from `services/grants.ts`; `isControlPairEnforced` from `services/control-pair.ts`; `nodes` from `db/schema`; `Capability` from `@agentpod/contract`.
- Produces:
  - `class GrantReachDenied extends Error { principalId: string; target: string; capability: string | null }`
  - `function isGrantReachDenied(e: unknown): e is GrantReachDenied`
  - `const REACH_BEARING: Record<Capability, boolean>`
  - `function isReachBearing(cap: Capability): boolean`
  - `async function requireGrantReach(userId: string, station: { nodeId: string; stationKey: string }, cap: Capability, effect: "read" | "mutate"): Promise<void>`
  - `async function requireFleetGrantReach(userId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `apps/hub/tests/integration/grant-reach.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Capability } from "@agentpod/contract";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { setGrant, deleteGrant } from "../../src/services/grants";
import {
  REACH_BEARING,
  isReachBearing,
  requireGrantReach,
  requireFleetGrantReach,
} from "../../src/services/grant-reach";
import { isGrantReachDenied } from "../../src/services/control-pair";

/**
 * The second half of the control pair.
 *
 * `mayDispatch` asks may I ask this agent to work; `mayGrantReach` asks may I
 * change what this agent is. Without the second, the first guards the front door
 * of a building with no walls: a principal refused one agent opens a terminal on
 * an agent they ARE allowed to dispatch and writes credentials into it.
 */

const USER = "test-user-grant-reach";
const NODE = "node_grant_reach";

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "grant-reach@example.com", name: "GR" });
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, (SELECT tenant_id FROM "user" WHERE id = ${USER}), ${USER},
            'reach-box', 'reach-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

const STATION = { nodeId: NODE, stationKey: "hermes:analyst-echo" };

async function denial(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("the capability classification", () => {
  test("covers every capability the contract defines", () => {
    // The Record type already fails the build when a capability is added. This
    // asserts the same thing at runtime, so widening the type later cannot
    // silently reopen the hole.
    expect(Object.keys(REACH_BEARING).sort()).toEqual([...Capability.options].sort());
  });

  test("names writes, shells and destruction — and nothing else", () => {
    expect(isReachBearing("fs.write")).toBe(true);
    expect(isReachBearing("terminal")).toBe(true);
    expect(isReachBearing("cleanup")).toBe(true);

    // Reads are not reach. A console that refused to show a diff or a log would
    // be routed around within a day.
    expect(isReachBearing("changeset")).toBe(false);
    expect(isReachBearing("fs.read")).toBe(false);
    expect(isReachBearing("logs")).toBe(false);
    expect(isReachBearing("health")).toBe(false);
    expect(isReachBearing("inventory")).toBe(false);

    // Operating an agent is not widening it, and dispatch already guards acp.
    expect(isReachBearing("lifecycle")).toBe(false);
    expect(isReachBearing("acp")).toBe(false);
  });
});

describe("requireGrantReach", () => {
  test("permits when the principal holds reach and the scope matches", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:reach-box/hermes:*"], mayGrantReach: true });
    expect(await denial(() => requireGrantReach(USER, STATION, "fs.write", "mutate"))).toBeNull();
  });

  test("refuses without the boolean, however wide the dispatch scope", async () => {
    // The whole point: dispatch permission is not permission to rewrite.
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    const e = await denial(() => requireGrantReach(USER, STATION, "fs.write", "mutate"));
    expect(isGrantReachDenied(e)).toBe(true);
  });

  test("refuses when the boolean is held but this station is out of scope", async () => {
    // One scope, shared with dispatch: you may rewrite only agents you may talk to.
    await setGrant(USER, { mayDispatch: ["agentpod:other-box/hermes:*"], mayGrantReach: true });

    const e = await denial(() => requireGrantReach(USER, STATION, "terminal", "mutate"));
    expect(isGrantReachDenied(e)).toBe(true);
  });

  test("refuses a principal with no grant at all", async () => {
    await deleteGrant(USER);
    const e = await denial(() => requireGrantReach(USER, STATION, "terminal", "mutate"));
    expect(isGrantReachDenied(e)).toBe(true);
  });

  test("lets a read through even on a reach-bearing capability", async () => {
    // `cleanup` covers plan (read) and apply (destroys) under one word.
    await setGrant(USER, { mayDispatch: [], mayGrantReach: false });
    expect(await denial(() => requireGrantReach(USER, STATION, "cleanup", "read"))).toBeNull();
  });

  test("lets an open capability through even when mutating", async () => {
    await setGrant(USER, { mayDispatch: [], mayGrantReach: false });
    expect(await denial(() => requireGrantReach(USER, STATION, "lifecycle", "mutate"))).toBeNull();
  });

  test("is a no-op when the pair is not enforced", async () => {
    const before = process.env.ENFORCE_CONTROL_PAIR;
    try {
      process.env.ENFORCE_CONTROL_PAIR = "false";
      await setGrant(USER, { mayDispatch: [], mayGrantReach: false });
      expect(await denial(() => requireGrantReach(USER, STATION, "terminal", "mutate"))).toBeNull();
    } finally {
      if (before === undefined) delete process.env.ENFORCE_CONTROL_PAIR;
      else process.env.ENFORCE_CONTROL_PAIR = before;
    }
  });
});

describe("requireFleetGrantReach", () => {
  test("permits a principal whose authority already spans the fleet", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: true });
    expect(await denial(() => requireFleetGrantReach(USER))).toBeNull();
  });

  test("refuses a node-scoped principal, who could otherwise grow the fleet forever", async () => {
    // Decision 4 counts *registering* an agent as granting reach: build the
    // agent you want, then dispatch it. A machine added under a node-scoped
    // grant is a machine that grant never described.
    await setGrant(USER, { mayDispatch: ["agentpod:reach-box/hermes:*"], mayGrantReach: true });

    const e = await denial(() => requireFleetGrantReach(USER));
    expect(isGrantReachDenied(e)).toBe(true);
  });

  test("refuses fleet-wide dispatch without the boolean", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });
    expect(isGrantReachDenied(await denial(() => requireFleetGrantReach(USER)))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/grant-reach.test.ts
```

Expected: FAIL — `Cannot find module '../../src/services/grant-reach'`.

- [ ] **Step 3: Add the error type**

Append to `apps/hub/src/services/control-pair.ts`:

```ts
/**
 * An act refused by the second half of the pair.
 *
 * Separate from `ControlPairDenied` rather than a subclass of it, deliberately:
 * the kaambaan bridge treats a `ControlPairDenied` as a permanent dispatch
 * refusal and stops retrying. A refusal to *write into* an agent must never be
 * mistaken for one, or a bridge fault would be diagnosed as a grant problem.
 */
export class GrantReachDenied extends Error {
  readonly principalId: string;
  /** The station key, or "fleet" for acts that name no station. */
  readonly target: string;
  readonly capability: string | null;

  constructor(principalId: string, target: string, capability: string | null) {
    super("You do not have permission to change this agent.");
    this.name = "GrantReachDenied";
    this.principalId = principalId;
    this.target = target;
    this.capability = capability;
  }
}

/** Is this the reach half refusing, rather than something transient? */
export function isGrantReachDenied(e: unknown): e is GrantReachDenied {
  return e instanceof GrantReachDenied || (e as { name?: string })?.name === "GrantReachDenied";
}
```

- [ ] **Step 4: Write the guards**

Create `apps/hub/src/services/grant-reach.ts`:

```ts
/**
 * Who may change what an agent *is*.
 *
 * `mayDispatch` asks whether you may ask an agent to work. This asks whether you
 * may rewrite it — put bytes in its workspace, run commands as it, destroy its
 * files, or bring a new machine into the fleet. Decision 4 of
 * `charter/decisions/2026-08-13-ecosystem-identity.md` requires both, because
 * dispatch control alone is decorative: anyone who can grant an agent production
 * credentials does not need permission to dispatch it — they build the agent
 * they want.
 *
 * Design: `docs/superpowers/specs/2026-08-15-granting-reach-design.md`.
 */

import { eq } from "drizzle-orm";
import { Capability } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { nodes } from "../db/schema";
import { getGrant, grantAllowsStation, AGENTPOD_NS } from "./grants";
import { isControlPairEnforced, GrantReachDenied } from "./control-pair";
import { createLogger } from "../utils/logger";

const log = createLogger("grant-reach");

/**
 * Which capabilities can hand an agent reach it did not have.
 *
 * `Record<Capability, boolean>` and not a Set: this is exhaustive by type, so
 * adding an eleventh capability to the contract enum stops the build until
 * somebody decides what it is. The same manoeuvre `db/tenant-scope.ts` uses to
 * stop a new table quietly escaping tenancy.
 *
 * `cleanup` is true even though half its surface is a read — the effect
 * argument, not the capability, decides that. A capability is listed here if
 * ANY route under it can change the agent.
 */
export const REACH_BEARING: Record<Capability, boolean> = {
  "fs.write": true,   // writes a credential file in one request
  terminal: true,     // arbitrary shell as the agent's user
  cleanup: true,      // `apply` deletes; `plan` is a read and passes on effect

  changeset: false,   // status/diff are reads
  lifecycle: false,   // operating an agent, not widening it
  acp: false,         // dispatch — mayDispatch already guards it
  inventory: false,
  health: false,
  logs: false,
  "fs.read": false,
};

export function isReachBearing(cap: Capability): boolean {
  return REACH_BEARING[cap] === true;
}

/**
 * Guard a station-scoped act.
 *
 * Two conditions, both required: the principal holds `mayGrantReach`, AND their
 * dispatch scope covers this station. One scope list, shared with dispatch, so
 * the two can never disagree about what a pattern means — `grantAllowsStation`
 * is the same function `acp.createSession` calls.
 */
export async function requireGrantReach(
  userId: string,
  station: { nodeId: string; stationKey: string },
  cap: Capability,
  effect: "read" | "mutate"
): Promise<void> {
  if (!isControlPairEnforced()) return;
  if (effect === "read" || !isReachBearing(cap)) return;

  const grant = await getGrant(userId);
  if (!grant?.mayGrantReach) {
    log.warn("reach refused by the control pair: principal may not change agents", {
      principalId: userId,
      stationKey: station.stationKey,
      capability: cap,
    });
    throw new GrantReachDenied(userId, station.stationKey, cap);
  }

  // The node name, because a grant names a node as well as a station — station
  // keys repeat across the fleet.
  const [node] = await db
    .select({ name: nodes.name })
    .from(nodes)
    .where(eq(nodes.id, station.nodeId))
    .limit(1);

  const inScope =
    node !== undefined &&
    grantAllowsStation(grant, { nodeName: node.name, stationKey: station.stationKey });

  if (!inScope) {
    log.warn("reach refused by the control pair: station out of scope", {
      principalId: userId,
      node: node?.name,
      stationKey: station.stationKey,
      capability: cap,
    });
    throw new GrantReachDenied(userId, station.stationKey, cap);
  }
}

/**
 * Guard an act that names no station — minting an enrollment token today, the
 * credential broker later.
 *
 * There is no station to match a pattern against, so the rule is narrower: you
 * may grow a fleet only if your authority already spans it. The alternative —
 * the boolean alone — would let a principal scoped to one node add machines
 * indefinitely, which is the "register an agent" half of Decision 4's threat
 * restated.
 */
export async function requireFleetGrantReach(userId: string): Promise<void> {
  if (!isControlPairEnforced()) return;

  const grant = await getGrant(userId);
  const fleetWide =
    grant?.mayGrantReach === true &&
    grant.mayDispatch.some(
      (v) => v.startsWith(AGENTPOD_NS) && v.slice(AGENTPOD_NS.length).startsWith("*/")
    );

  if (!fleetWide) {
    log.warn("fleet-level reach refused by the control pair", { principalId: userId });
    throw new GrantReachDenied(userId, "fleet", null);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/grant-reach.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/grant-reach.ts apps/hub/src/services/control-pair.ts \
        apps/hub/tests/integration/grant-reach.test.ts
git commit -m "feat(hub): classify which capabilities grant an agent its reach"
```

---

### Task 2: Guard the four `fs.write` routes

**Files:**
- Modify: `apps/hub/src/routes/station-writes.ts` (4 route handlers)
- Test: `apps/hub/tests/integration/station-writes-reach.test.ts`

**Interfaces:**
- Consumes: `requireGrantReach` and `isGrantReachDenied` from Task 1.
- Produces: nothing new — routes answer 403 with `{ error: "You do not have permission to change this agent." }`.

- [ ] **Step 1: Write the failing test**

Create `apps/hub/tests/integration/station-writes-reach.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { setGrant } from "../../src/services/grants";
import { stationWriteRoutes } from "../../src/routes/station-writes";

/**
 * Writing into an agent's workspace is granting it reach.
 *
 * One request writes `~/.claude/settings.json` or an `.env`. That is the act
 * `mayGrantReach` exists to govern, and until this test existed the dispatch
 * check was guarding the front door of a building with no walls.
 */

const USER = "test-user-writes-reach";
const NODE = "node_writes_reach";
const STATION = "station_writes_reach";

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: USER, role: "user" });
    await next();
  });
  a.route("/", stationWriteRoutes);
  return a;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "writes-reach@example.com", name: "WR" });
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, (SELECT tenant_id FROM "user" WHERE id = ${USER}), ${USER},
            'writes-box', 'writes-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${STATION}, (SELECT tenant_id FROM "user" WHERE id = ${USER}), ${USER}, ${NODE},
            'hermes', 'hermes:writes', 'leaf', 'Writes', '["fs.write"]'::jsonb, now(), now())`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM station_audit WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

const BODIES: Array<[string, unknown]> = [
  ["fs/write", { path: "a.txt", content: "x", encoding: "utf8" }],
  ["fs/mkdir", { path: "d" }],
  ["fs/move", { from: "a.txt", to: "b.txt" }],
  ["fs/delete", { path: "a.txt" }],
];

describe("fs mutations require reach", () => {
  test.each(BODIES)("%s is refused without mayGrantReach", async (path, body) => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    const res = await app().request(`/stations/${STATION}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    // 403, not 502: this is a decision, not an upstream failure (#342).
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/permission to change this agent/i);
  });

  test("a refusal is audited, not only logged", async () => {
    // An attempt refused and recorded nowhere is indistinguishable from an
    // attempt nobody made.
    await rawSql`DELETE FROM station_audit WHERE user_id = ${USER}`;
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    await app().request(`/stations/${STATION}/fs/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "a.txt", content: "x", encoding: "utf8" }),
    });

    const rows = await rawSql`
      SELECT verb, result FROM station_audit WHERE user_id = ${USER} AND verb = 'fs.write'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.result).toBe("error");
  });

  test("the guard runs after the capability gate, so a station without fs.write still 403s on capability", async () => {
    // Ordering matters for the message: "this station cannot" and "you may not"
    // are different answers and an operator needs the right one.
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: true });
    await rawSql`UPDATE stations SET capabilities = '[]'::jsonb WHERE id = ${STATION}`;

    const res = await app().request(`/stations/${STATION}/fs/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "a.txt", content: "x", encoding: "utf8" }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/does not advertise/i);

    await rawSql`UPDATE stations SET capabilities = '["fs.write"]'::jsonb WHERE id = ${STATION}`;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/station-writes-reach.test.ts
```

Expected: FAIL — the routes answer 409/502 (broker: node offline) instead of 403, because no guard exists yet.

- [ ] **Step 3: Add the guard to all four routes**

In `apps/hub/src/routes/station-writes.ts`, add the import:

```ts
import { requireGrantReach } from "../services/grant-reach";
import { isGrantReachDenied } from "../services/control-pair";
```

Then in **each** of the four handlers, immediately after the existing capability gate block (`if (!gateCapability(station, "fs.write")) { … }`) and before the audit call, insert:

```ts
      // ── 3b. Reach gate ──────────────────────────────────────────────────────
      // Writing into a workspace is how an agent gets credentials it did not
      // have. Dispatch permission is not permission to rewrite (Decision 4).
      try {
        await requireGrantReach(user.id, station, "fs.write", "mutate");
      } catch (e) {
        if (!isGrantReachDenied(e)) throw e;
        const denied = await recordAudit(db, {
          userId: user.id,
          nodeId: station.nodeId,
          stationKey: station.stationKey,
          verb: "fs.write",
          params: { refused: "grant-reach" },
        });
        await denied.done("error", "refused by the control pair");
        return c.json({ error: e.message }, 403);
      }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/station-writes-reach.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the existing write tests for regression**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/station-writes.test.ts
```

Expected: PASS — those tests do not set `ENFORCE_CONTROL_PAIR`, so the guard is a no-op.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/routes/station-writes.ts apps/hub/tests/integration/station-writes-reach.test.ts
git commit -m "feat(hub): a workspace write requires mayGrantReach"
```

---

### Task 3: Guard the terminal socket

**Files:**
- Modify: `apps/hub/src/routes/station-terminal.ts` (after the capability gate, before `recordAudit`)
- Test: `apps/hub/tests/integration/station-terminal-reach.test.ts`

**Interfaces:**
- Consumes: `requireGrantReach`, `isGrantReachDenied`.
- Produces: WS close code **1008** with an `{ t: "exit" }` frame first, matching the capability gate beside it.

- [ ] **Step 1: Write the failing test**

Create `apps/hub/tests/integration/station-terminal-reach.test.ts`, modelled on the existing `station-terminal.test.ts` harness (read it first for the WS client helper it uses):

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { setGrant } from "../../src/services/grants";

/**
 * A terminal is the most complete way to change what an agent is.
 *
 * The route's own comment already calls it "the most powerful mutation". It is
 * the one surface where a refusal has to be unmistakable — a shell that opens
 * and then does nothing would read as a broken node.
 */

const USER = "test-user-terminal-reach";
const NODE = "node_terminal_reach";
const STATION = "station_terminal_reach";

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "terminal-reach@example.com", name: "TR" });
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, (SELECT tenant_id FROM "user" WHERE id = ${USER}), ${USER},
            'term-box', 'term-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${STATION}, (SELECT tenant_id FROM "user" WHERE id = ${USER}), ${USER}, ${NODE},
            'hermes', 'hermes:term', 'leaf', 'Term', '["terminal"]'::jsonb, now(), now())`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM station_audit WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

describe("the terminal requires reach", () => {
  test("closes 1008 for a principal who may dispatch but not change", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    const { code } = await openTerminal(USER, STATION);
    expect(code).toBe(1008);
  });

  test("opens for a principal who holds reach in scope", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:term-box/hermes:*"], mayGrantReach: true });

    const { code } = await openTerminal(USER, STATION);
    // Not 1008: the refusal is gone. (It closes on "node offline" instead —
    // there is no live node in this suite, which is the next gate down.)
    expect(code).not.toBe(1008);
  });
});
```

> The `openTerminal(userId, stationId)` helper: copy the WS-client helper out of
> the existing `apps/hub/tests/integration/station-terminal.test.ts` — it builds a
> minimal Hono app with a stub auth middleware, serves it on an ephemeral port,
> connects a `WebSocket`, and resolves `{ code, frames }` on close. Do not import
> `src/index.ts`; it starts the sweeper.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/station-terminal-reach.test.ts
```

Expected: FAIL — first case closes on "node offline" (1011), not 1008.

- [ ] **Step 3: Add the guard**

In `apps/hub/src/routes/station-terminal.ts`, after the `gateCapability(station, "terminal")` block and **before** the node-reachability check:

```ts
        // ── 2c. Reach gate ────────────────────────────────────────────────
        // A shell is the most complete way to change what an agent is, so it
        // is the clearest case for the second half of the pair.
        try {
          await requireGrantReach(user.id, station, "terminal", "mutate");
        } catch (e) {
          if (!isGrantReachDenied(e)) throw e;
          const denied = await recordAudit(db, {
            userId: user.id,
            nodeId: station.nodeId,
            stationKey: station.stationKey,
            verb: "term.attach",
            params: { refused: "grant-reach" },
          });
          await denied.done("error", "refused by the control pair");
          ws.send(JSON.stringify({ t: "exit" }));
          ws.close(1008, "Forbidden: may not change this agent");
          return;
        }
```

with the imports added at the top:

```ts
import { requireGrantReach } from "../services/grant-reach";
import { isGrantReachDenied } from "../services/control-pair";
```

- [ ] **Step 4: Run both terminal test files**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/station-terminal-reach.test.ts tests/integration/station-terminal.test.ts
```

Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/routes/station-terminal.ts apps/hub/tests/integration/station-terminal-reach.test.ts
git commit -m "feat(hub): a terminal requires mayGrantReach"
```

---

### Task 4: Guard `cleanup/apply`, and prove the open capabilities stay open

**Files:**
- Modify: `apps/hub/src/routes/station-cleanup.ts` (the `apply` handler only)
- Test: `apps/hub/tests/integration/station-cleanup-reach.test.ts`

**Interfaces:**
- Consumes: `requireGrantReach`, `isGrantReachDenied`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `apps/hub/tests/integration/station-cleanup-reach.test.ts`. Set up a user, node and station exactly as Task 2 does (capabilities `'["cleanup","changeset","lifecycle"]'::jsonb`), then:

```ts
describe("cleanup splits along the effect, not the capability", () => {
  test("apply is refused without reach", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    const res = await app().request(`/stations/${STATION}/cleanup/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: ["node_modules"] }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/permission to change this agent/i);
  });

  test("plan is not, because looking is not changing", async () => {
    // One capability word covers a read and a destruction. Guarding the word
    // would refuse someone permission to find out what would be deleted.
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    const res = await app().request(`/stations/${STATION}/cleanup/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).not.toBe(403);
  });
});

describe("the open capabilities are untouched", () => {
  // These are the negative cases that catch an over-broad classification — the
  // failure that would have people turn the control off rather than narrow it.
  test("changeset status is allowed without reach", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });
    const res = await changesetApp().request(`/stations/${STATION}/changeset/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });

  test("lifecycle is allowed without reach", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });
    const res = await lifecycleApp().request(`/stations/${STATION}/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restart" }),
    });
    expect(res.status).not.toBe(403);
  });
});
```

`app()`, `changesetApp()` and `lifecycleApp()` are the same minimal-Hono pattern as Task 2, each mounting `stationCleanupRoutes`, `stationChangesetRoutes` and `stationLifecycleRoutes` respectively.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/station-cleanup-reach.test.ts
```

Expected: FAIL on the apply case (not 403); the three others pass already.

- [ ] **Step 3: Guard only the apply handler**

In `apps/hub/src/routes/station-cleanup.ts`, in the **apply** handler only, after its `gateCapability(station, "cleanup")` check:

```ts
      // ── Reach gate (apply only) ─────────────────────────────────────────
      // `plan` above shares this capability and is a read; deleting an agent's
      // files is not.
      try {
        await requireGrantReach(user.id, station, "cleanup", "mutate");
      } catch (e) {
        if (!isGrantReachDenied(e)) throw e;
        return c.json({ error: e.message }, 403);
      }
```

plus the two imports used in Tasks 2 and 3.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/station-cleanup-reach.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/routes/station-cleanup.ts apps/hub/tests/integration/station-cleanup-reach.test.ts
git commit -m "feat(hub): cleanup apply requires mayGrantReach; plan stays a read"
```

---

### Task 5: Guard enrollment — growing the fleet

**Files:**
- Modify: `apps/hub/src/routes/enrollment-tokens.ts`
- Test: `apps/hub/tests/integration/enrollment-token-reach.test.ts`

**Interfaces:**
- Consumes: `requireFleetGrantReach`, `isGrantReachDenied`.
- Produces: 403 on `POST /api/enrollment-tokens` for a principal without fleet-wide authority.

- [ ] **Step 1: Write the failing test**

```ts
describe("minting an enrollment token is granting reach", () => {
  test("refused for a node-scoped principal", async () => {
    // Decision 4: "anyone who can register an agent and grant it production
    // credentials … they build the agent they want."
    await setGrant(USER, { mayDispatch: ["agentpod:one-box/hermes:*"], mayGrantReach: true });

    const res = await app().request("/", { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("permitted when the principal's authority already spans the fleet", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: true });

    const res = await app().request("/", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string }).token).toBeTruthy();
  });

  test("refused without the boolean, however wide the scope", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });
    expect((await app().request("/", { method: "POST" })).status).toBe(403);
  });
});
```

with the same `beforeAll`/`afterAll` shape as Task 2 (user + `ENFORCE_CONTROL_PAIR = "true"`, cleaning `enrollment_tokens` too), and `app()` mounting `enrollmentTokenRoutes` at `/`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/enrollment-token-reach.test.ts
```

Expected: FAIL — all three mint a token (200).

- [ ] **Step 3: Add the guard**

Rewrite `apps/hub/src/routes/enrollment-tokens.ts`:

```ts
import { Hono } from "hono";
import { mintEnrollmentToken } from "../services/enrollment";
import { requireFleetGrantReach } from "../services/grant-reach";
import { isGrantReachDenied } from "../services/control-pair";

/**
 * POST /api/enrollment-tokens
 * Authenticated route — mints a one-time enrollment token for the current user.
 * Returns { token, expiresAt } where `token` is the plaintext token (shown once).
 *
 * Behind the reach half of the control pair: a machine joining the fleet is an
 * agent being *registered*, which Decision 4 names as granting reach. It has no
 * station to scope against, so it asks the narrower question — does this
 * principal's authority already span the fleet.
 */
export const enrollmentTokenRoutes = new Hono().post("/", async (c) => {
  const user = c.get("user");
  try {
    await requireFleetGrantReach(user.id);
  } catch (e) {
    if (!isGrantReachDenied(e)) throw e;
    return c.json({ error: "You do not have permission to add machines to this fleet." }, 403);
  }
  const { token, expiresAt } = await mintEnrollmentToken(user.id);
  return c.json({ token, expiresAt: expiresAt.toISOString() });
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/enrollment-token-reach.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Run the whole hub suite**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Expected: PASS (1138 + the new tests). Any failure here is a real regression — earlier suites do not set the flag, so a break means a guard is firing when the pair is off.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/routes/enrollment-tokens.ts apps/hub/tests/integration/enrollment-token-reach.test.ts
git commit -m "feat(hub): growing the fleet requires fleet-wide authority"
```

---

### Task 6: The console says why, before you click

**Files:**
- Create: `apps/console/src/lib/api/my-grant.ts`
- Create: `apps/console/src/lib/api/my-grant.test.ts`
- Modify: `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte` (tab list)
- Modify: `apps/console/src/lib/components/admin/GrantDialog.svelte` (copy only)

**Interfaces:**
- Consumes: `/api/auth/token` on the hub (already public to authenticated callers).
- Produces: `async function myReach(): Promise<{ mayGrantReach: boolean }>` — cached per page load, never throwing.

- [ ] **Step 1: Write the failing test**

Create `apps/console/src/lib/api/my-grant.test.ts`:

```ts
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { myReach, forgetMyReach } from "./my-grant";

/**
 * What this browser may do, according to the issuer.
 *
 * Read from the principal's own token rather than a new endpoint — the same
 * mechanism kaambaan's web app uses. It is advisory: the hub decides. A console
 * that guessed "allowed" and let a click 403 is a worse experience than a
 * disabled button, and a console that guessed "denied" would hide a control
 * someone actually holds — so a failure to find out must read as neither.
 */

function tokenWith(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/=+$/, "");
  return `header.${payload}.signature`;
}

beforeEach(() => {
  forgetMyReach();
  vi.restoreAllMocks();
});
afterEach(() => forgetMyReach());

test("reports the claim the issuer put in the token", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ token: tokenWith({ mayGrantReach: true }) }), { status: 200 })
  ));
  expect((await myReach()).mayGrantReach).toBe(true);
});

test("reports false when the claim says false", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ token: tokenWith({ mayGrantReach: false }) }), { status: 200 })
  ));
  expect((await myReach()).mayGrantReach).toBe(false);
});

test("assumes permitted when it cannot find out, and lets the hub refuse", async () => {
  // The hub is the authority. Guessing "denied" here would hide a control the
  // operator holds, on a deployment where the pair may not even be enforced.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  expect((await myReach()).mayGrantReach).toBe(true);
});

test("asks once per page load", async () => {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify({ token: tokenWith({ mayGrantReach: true }) }), { status: 200 })
  );
  vi.stubGlobal("fetch", spy);

  await myReach();
  await myReach();
  expect(spy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/console && pnpm vitest run src/lib/api/my-grant.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/console/src/lib/api/my-grant.ts`:

```ts
/**
 * What this browser's principal may do, according to the issuer.
 *
 * Read out of the principal's own token rather than from a new endpoint — the
 * hub already mints one at `/api/auth/token` carrying `mayDispatch` and
 * `mayGrantReach`, and kaambaan's web app reads it the same way (kaambaan#43).
 *
 * **Advisory only.** The hub decides; this exists so a control that will be
 * refused can say so before it is clicked. When it cannot find out it answers
 * *permitted* and lets the hub refuse: guessing "denied" would hide a control
 * the operator actually holds — on a deployment where the pair may not even be
 * enforced — which is the worse of the two wrong answers.
 */

import { http } from "./client";

export interface MyReach {
  mayGrantReach: boolean;
}

const PERMITTED: MyReach = { mayGrantReach: true };

let cached: Promise<MyReach> | null = null;

function claimsOf(jwt: string): Record<string, unknown> | null {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

export function myReach(): Promise<MyReach> {
  if (cached) return cached;

  cached = (async () => {
    try {
      const { token } = await http<{ token?: string }>("/api/auth/token");
      const claims = token ? claimsOf(token) : null;
      if (!claims || typeof claims.mayGrantReach !== "boolean") return PERMITTED;
      return { mayGrantReach: claims.mayGrantReach };
    } catch {
      return PERMITTED;
    }
  })();

  return cached;
}

/** Drop the cached answer — after signing out, or in tests. */
export function forgetMyReach(): void {
  cached = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/console && pnpm vitest run src/lib/api/my-grant.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Disable the Terminal tab when reach is absent**

In `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte`, add near the other state:

```svelte
  import { myReach } from "$lib/api/my-grant";

  let mayGrantReach = $state(true);
  onMount(async () => {
    mayGrantReach = (await myReach()).mayGrantReach;
  });
```

and change the terminal entry in the tabs array (currently line ~150) to:

```svelte
    ...(hasTerminal
      ? [{
          id: "terminal",
          label: "Terminal",
          icon: TerminalIcon,
          disabled: !mayGrantReach,
          // PageHeader renders a lock and this text as a tooltip.
          disabledReason: "You may dispatch this agent but not change it — mayGrantReach",
        }]
      : []),
```

`Tab` already carries `disabled` and `disabledReason` (`lib/components/page-header.svelte:8`), so no component change is needed.

- [ ] **Step 6: Update the dialog copy**

In `apps/console/src/lib/components/admin/GrantDialog.svelte`, replace the `May grant reach` description paragraph with:

```svelte
            <p class="text-xs text-muted-foreground">
              The second half of the pair: whether this principal may change what an agent
              <em>is</em> — write into its workspace, open a terminal on it, delete its files, or
              add a machine to the fleet. Dispatching an agent needs only the values above.
            </p>
```

- [ ] **Step 7: Run the console suite**

```bash
cd apps/console && pnpm check && pnpm vitest run src/lib src/routes/nodes
```

Expected: PASS. (The full `pnpm test` also passes; on Node 26 it shows ~132 unrelated pre-existing failures — use Node 22.)

- [ ] **Step 8: Commit**

```bash
git add apps/console/src/lib/api/my-grant.ts apps/console/src/lib/api/my-grant.test.ts \
        "apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte" \
        apps/console/src/lib/components/admin/GrantDialog.svelte
git commit -m "feat(console): say what you may not change, before the click"
```

---

### Task 7: Documentation and the charter decision

**Files:**
- Modify: `docs/DEPLOYMENT.md` (the control-pair section)
- Create: `../charter/decisions/2026-08-15-granting-reach-is-changing-an-agent.md`
- Modify: `docs/superpowers/plans/2026-08-15-issuer-driven-organization-layer.md` (tick §3)

- [ ] **Step 1: Add the capability table to DEPLOYMENT.md**

After the `mayGrantReach` row in the field table, insert:

```markdown
**What `mayGrantReach` gates.** The acts that change what an agent *is*, rather
than asking it to work:

| Act | Guarded |
|---|---|
| `fs/write`, `fs/mkdir`, `fs/move`, `fs/delete` | yes — one request writes a credential file |
| Terminal attach | yes — arbitrary shell as the agent's user |
| `cleanup/apply` | yes — deletes workspace files (`cleanup/plan` is a read, and is not) |
| `POST /api/enrollment-tokens` | yes — and additionally requires a fleet-wide (`agentpod:*/…`) dispatch value |
| `changeset/status`, `changeset/diff`, `lifecycle`, all reads | no |

A station-scoped act needs `mayGrantReach` **and** a `mayDispatch` value matching
that station: one scope, shared with dispatch, so narrowing what someone may
dispatch narrows what they may rewrite.

**If you lock yourself out**, `/api/admin/grants` is guarded by *admin*, not by
the pair — an admin can always restore their own grant from the console. The
control cannot lock you out of the control.
```

- [ ] **Step 2: Write the charter decision**

Create `charter/decisions/2026-08-15-granting-reach-is-changing-an-agent.md` recording: the line (dispatch = ask it to work, reach = change what it is); the shared-scope composition and why a second list was rejected; the capability classification with `lifecycle` on the dispatch side and the argument against it; the fleet-wide rule for station-less acts; and the credential broker as where this ends. Cross-link `[[2026-08-13-ecosystem-identity]]` and `[[2026-08-15-a-grant-names-an-agent-per-plane]]`.

- [ ] **Step 3: Tick the plan item**

In `docs/superpowers/plans/2026-08-15-issuer-driven-organization-layer.md`, replace the `STILL OPEN` bullet in §3 with a ticked box naming this plan and the issue.

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOYMENT.md docs/superpowers/plans/2026-08-15-issuer-driven-organization-layer.md
git commit -m "docs: what mayGrantReach gates, and how not to lock yourself out"
```

(The charter is a separate repo — commit and push it there on its own branch.)

---

### Task 8: Verify against production

Production is the test environment for this work, by the operator's decision. Enforcement is already on and the only principal holds `mayGrantReach: true` with fleet-wide values, so step 1 must show **no change at all**.

- [ ] **Step 1: Confirm the no-op**

Merge, deploy the hub (`git merge --ff-only` on `/opt/agentpod` at `root@178.105.68.68`, then `systemctl restart agentpod-hub`), redeploy the console (`PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm --filter @agentpod/console build`, then `npx wrangler pages deploy apps/console/build --project-name agentpod-console`). Then, in the console: open a terminal on a live station, write a file. Both must work exactly as before.

- [ ] **Step 2: Prove the refusal**

Set your own `mayGrantReach` to false in **Admin → Grants**. Reload the station page:

- the Terminal tab shows a lock with the reason,
- forcing the socket anyway closes 1008,
- a file write answers 403,
- both refusals appear in the station's Activity tab, not only in the hub log,
- the Chat tab still works — dispatch is unaffected.

- [ ] **Step 3: Restore and confirm recovery**

Set `mayGrantReach` back to true. Terminal and writes work again. Record the run in the issue.

---

## Self-review

**Spec coverage.** The line (Tasks 2–5), composition (Task 1), fleet rule (Tasks 1, 5), classification table with `cleanup` effect-splitting (Tasks 1, 4), guards beside `gateCapability` (Tasks 2–4), 403 / 1008 / audited refusals (Tasks 2, 3), console advisory (Task 6), same switch (Global Constraints, asserted in Task 1), lockout recoverable (Task 7), production verification (Task 8), credential-broker migration (Task 7's decision doc). No spec section is unclaimed.

**Deviation.** Guards live in `services/grant-reach.ts` rather than `control-pair.ts`; the error type stays in `control-pair.ts`. Reasoned above.

**Type consistency.** `requireGrantReach(userId, station, cap, effect)` and `requireFleetGrantReach(userId)` are used with those exact signatures in Tasks 2–5; `isGrantReachDenied` is the guard everywhere; `myReach()`/`forgetMyReach()` match between the test and the implementation in Task 6; `REACH_BEARING` keys match `Capability.options` by construction and by assertion.
