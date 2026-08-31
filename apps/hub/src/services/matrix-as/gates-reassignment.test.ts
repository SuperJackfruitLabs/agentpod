/**
 * The room follows the agent — Task 5, closing slice A's finding I2.
 *
 * `matrix_rooms.principal_id` gains its first writer in `routes/agents-
 * admin.ts`'s assign endpoint, and `gates.ts` reads it in preference to the
 * plain `stationId` join. This proves the thing that actually matters: a
 * reassigned agent's gate lands in the SAME room it always had — not merely
 * that some column got written. Runs against the real Postgres test
 * database, exercising the real admin routes rather than writing to
 * `matrix_rooms` by hand, so this is the same write path an operator's click
 * goes through.
 *
 * **Fix round: occupancy is exclusive.** A principal runs in one station at
 * a time (`stations_principal_id_idx`), assigning an already-placed
 * principal elsewhere is a MOVE (no manual unassign required), and the
 * `stationId` fallback that used to hand a new occupant another principal's
 * room is scoped to stations with no current occupant at all. The most
 * important test below is the one the review's finding named directly: when
 * P leaves a station and Q takes it, Q's gate must reach Q's own room,
 * answered as `@agent_Q` — never P's room, never `@agent_P`.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { createTestUser } from "../../../tests/helpers/database";
import { db, rawSql } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { matrixRooms } from "../../db/schema/matrix";
import { bridgeDispatches } from "../../db/schema/bridge";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { mintEnrollmentToken, enrollNode } from "../enrollment";
import { createPrincipal } from "../principals";
import { adminMiddleware } from "../../auth/admin-middleware";
import { agentsAdminRouter } from "../../routes/agents-admin";
import { projectGate, roomAgentUser } from "./gates";
import { bridgeUserId } from "./names";
import { provisionStation } from "./provision";
import type { GatePendingDelivery } from "./gates";

const RUN = crypto.randomUUID().slice(0, 8);
const HANDLE_PREFIX = `gates-reassign-${RUN}`;
const ADMIN_ACTOR = `test-admin-actor-gates-reassign-${RUN}`;

let stationAId: string;
let stationBId: string;
let principalId: string;
let sharedNodeId: string;

function adminApp() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: ADMIN_ACTOR, authType: "api_key", tenantId: "default" });
    await next();
  });
  a.use("*", adminMiddleware);
  a.route("/", agentsAdminRouter);
  return a;
}

const app = adminApp();

async function assign(stationId: string, principal: string) {
  const res = await app.request(`/stations/${stationId}/agent`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: principal }),
  });
  expect(res.status).toBe(200);
}

async function unassign(stationId: string) {
  const res = await app.request(`/stations/${stationId}/agent`, { method: "DELETE" });
  expect(res.status).toBe(200);
}

async function roomRow(roomId: string) {
  const [row] = await db
    .select({ stationId: matrixRooms.stationId, principalId: matrixRooms.principalId })
    .from(matrixRooms)
    .where(eq(matrixRooms.roomId, roomId));
  return row;
}

beforeAll(async () => {
  await ensurePgMigrations();

  await createTestUser({
    id: ADMIN_ACTOR,
    email: `gates-reassign-actor-${RUN}@example.com`,
    name: "Actor",
    role: "admin",
  });

  const { token } = await mintEnrollmentToken(ADMIN_ACTOR);
  const { nodeId } = await enrollNode(token, {
    hostname: `gates-reassign-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 1,
  });
  sharedNodeId = nodeId;

  stationAId = `st_gra_a_${RUN}`;
  stationBId = `st_gra_b_${RUN}`;
  await db.insert(stations).values([
    {
      id: stationAId,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId: ADMIN_ACTOR,
      nodeId,
      harness: "opencode",
      stationKey: `opencode:${RUN}-a`,
      kind: "workspace",
      displayName: "Station A",
    },
    {
      id: stationBId,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId: ADMIN_ACTOR,
      nodeId,
      harness: "opencode",
      stationKey: `opencode:${RUN}-b`,
      kind: "workspace",
      displayName: "Station B",
    },
  ]);

  // Both stations are already provisioned with their own room — the ordinary
  // case, and the one that actually exercises the fix: station B having a
  // room of its own is exactly what would swallow the agent's history if
  // `roomForCard` still preferred the dispatch's own station-tied room.
  await db.insert(matrixRooms).values([
    {
      roomId: `!room-a-${RUN}:id.agentpod.dev`,
      tenantId: BOOTSTRAP_TENANT_ID,
      stationId: stationAId,
      alias: `#a-${RUN}:id.agentpod.dev`,
    },
    {
      roomId: `!room-b-${RUN}:id.agentpod.dev`,
      tenantId: BOOTSTRAP_TENANT_ID,
      stationId: stationBId,
      alias: `#b-${RUN}:id.agentpod.dev`,
    },
  ]);

  principalId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-agent` });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM matrix_gate_events WHERE tenant_id = ${BOOTSTRAP_TENANT_ID} AND board_id LIKE ${"brd_" + RUN + "%"}`;
    await rawSql`DELETE FROM bridge_dispatches WHERE tenant_id = ${BOOTSTRAP_TENANT_ID} AND external_source = 'kaambaan' AND board_id LIKE ${"brd_" + RUN + "%"}`;
    // `matrix_rooms` cascades from `stations` (ON DELETE CASCADE), so every
    // room this file created — however many stations it added below — goes
    // with it, without listing station ids by hand.
    await rawSql`DELETE FROM stations WHERE user_id = ${ADMIN_ACTOR}`;
    await rawSql`DELETE FROM nodes WHERE user_id = ${ADMIN_ACTOR}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${ADMIN_ACTOR}`;
    await rawSql`DELETE FROM principals WHERE handle LIKE ${HANDLE_PREFIX + "%"}`;
    await rawSql`DELETE FROM "user" WHERE id = ${ADMIN_ACTOR}`;
  } catch {
    // cleanup only
  }
});

function delivery(gateId: string, cardId: string): GatePendingDelivery {
  return {
    event: "gate.pending",
    boardId: `brd_${RUN}`,
    cardId,
    gateId,
    stageKey: "review",
    returnStageKey: "code",
    cardTitle: "Ship the fix",
    producedBy: "agt_x",
    options: [{ id: "approve", label: "Approve" }],
    ts: "2026-08-31T00:00:00.000Z",
  };
}

function fakeDeps() {
  const sent: Array<{ userId: string; roomId: string }> = [];
  return {
    sent,
    deps: {
      domain: "id.agentpod.dev",
      sendText: async (userId: string, roomId: string) => {
        sent.push({ userId, roomId });
        // `matrix_gate_events.event_id` is globally unique, and this file
        // runs several gates through several `fakeDeps()` calls — a plain
        // per-call counter (`$prose-1`, `$prose-2`, …) collides across
        // tests, not just within one.
        return `$prose-${crypto.randomUUID()}`;
      },
      sendCustomEvent: async (userId: string, roomId: string) => {
        sent.push({ userId, roomId });
        return `$gate-${crypto.randomUUID()}`;
      },
    },
  };
}

describe("reassignment: the room follows the agent, not the station", () => {
  test("a reassigned agent keeps its room, its id, and its history", async () => {
    // The principal is bound to station A's room on its first assignment —
    // the whole reason the mxid comes from a handle rather than a station.
    await assign(stationAId, principalId);
    const roomBefore = (await roomRow(`!room-a-${RUN}:id.agentpod.dev`))!;
    expect(roomBefore.principalId).toBe(principalId);

    // Reassigned to a DIFFERENT station that already has its OWN room.
    await unassign(stationAId);
    await assign(stationBId, principalId);

    // New work dispatched to the agent's new station.
    const cardId = `crd_${RUN}_1`;
    await db.insert(bridgeDispatches).values({
      externalSource: "kaambaan",
      externalRunId: `run_${RUN}_1`,
      tenantId: BOOTSTRAP_TENANT_ID,
      boardId: `brd_${RUN}`,
      externalCardId: cardId,
      agentKey: "test",
      stationId: stationBId,
      leaseEpoch: 1,
      outcome: "produced",
      startedAt: new Date(),
      updatedAt: new Date(),
    });

    const { deps, sent } = fakeDeps();
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, delivery(`gate_${RUN}_1`, cardId), deps);

    expect(outcome.status).toBe("sent");
    // Same room id as before reassignment — not station B's own room.
    expect((outcome as { roomId: string }).roomId).toBe(`!room-a-${RUN}:id.agentpod.dev`);
    expect(sent.every((s) => s.roomId === `!room-a-${RUN}:id.agentpod.dev`)).toBe(true);
  });

  test("station_id is not dropped — the sweep deployed on infra joins on it", async () => {
    const roomBefore = await roomRow(`!room-a-${RUN}:id.agentpod.dev`);
    expect(roomBefore!.stationId).not.toBeNull();
    expect(roomBefore!.stationId).toBe(stationAId);

    // Station B's own room was never touched by the reassignment — its
    // binding stays free for whoever occupies it next.
    const roomB = await roomRow(`!room-b-${RUN}:id.agentpod.dev`);
    expect(roomB!.stationId).toBe(stationBId);
    expect(roomB!.principalId).toBeNull();
  });

  test("roomAgentUser still answers for the agent's original room after it has moved on", async () => {
    // Station A is unassigned at this point in the suite (from the test
    // above) — the room's OWN binding, not the station's current occupant,
    // is what must answer here.
    const user = await roomAgentUser(`!room-a-${RUN}:id.agentpod.dev`, "id.agentpod.dev");
    expect(user).toBe(`@agent_${HANDLE_PREFIX}-agent:id.agentpod.dev`);
  });
});

describe("occupancy is exclusive — a principal runs in one station at a time", () => {
  let stationMoveAId: string;
  let stationMoveBId: string;
  let movePrincipalId: string;

  let stationXId: string;
  let stationYId: string;
  let pId: string;
  let qId: string;
  const roomX1 = `!room-x1-${RUN}:id.agentpod.dev`;
  const roomX2 = `!room-x2-${RUN}:id.agentpod.dev`;
  const roomY = `!room-y-${RUN}:id.agentpod.dev`;

  beforeAll(async () => {
    stationMoveAId = `st_gra_ma_${RUN}`;
    stationMoveBId = `st_gra_mb_${RUN}`;
    stationXId = `st_gra_x_${RUN}`;
    stationYId = `st_gra_y_${RUN}`;

    await db.insert(stations).values([
      {
        id: stationMoveAId,
        tenantId: BOOTSTRAP_TENANT_ID,
        userId: ADMIN_ACTOR,
        nodeId: sharedNodeId,
        harness: "opencode",
        stationKey: `opencode:${RUN}-ma`,
        kind: "workspace",
        displayName: "Station Move A",
      },
      {
        id: stationMoveBId,
        tenantId: BOOTSTRAP_TENANT_ID,
        userId: ADMIN_ACTOR,
        nodeId: sharedNodeId,
        harness: "opencode",
        stationKey: `opencode:${RUN}-mb`,
        kind: "workspace",
        displayName: "Station Move B",
      },
      {
        id: stationXId,
        tenantId: BOOTSTRAP_TENANT_ID,
        userId: ADMIN_ACTOR,
        nodeId: sharedNodeId,
        harness: "opencode",
        stationKey: `opencode:${RUN}-x`,
        kind: "workspace",
        displayName: "Station X",
      },
      {
        id: stationYId,
        tenantId: BOOTSTRAP_TENANT_ID,
        userId: ADMIN_ACTOR,
        nodeId: sharedNodeId,
        harness: "opencode",
        stationKey: `opencode:${RUN}-y`,
        kind: "workspace",
        displayName: "Station Y",
      },
    ]);

    await db.insert(matrixRooms).values([
      { roomId: roomX1, tenantId: BOOTSTRAP_TENANT_ID, stationId: stationXId, alias: `#x1-${RUN}:id.agentpod.dev` },
      { roomId: roomY, tenantId: BOOTSTRAP_TENANT_ID, stationId: stationYId, alias: `#y-${RUN}:id.agentpod.dev` },
    ]);

    movePrincipalId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-mover` });
    pId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-p` });
    qId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-q` });
  });

  test("assigning an already-placed principal elsewhere moves it — no manual unassign, and the old station ends up empty", async () => {
    await assign(stationMoveAId, movePrincipalId);
    const before = await db.select({ principalId: stations.principalId }).from(stations).where(eq(stations.id, stationMoveAId));
    expect(before[0]!.principalId).toBe(movePrincipalId);

    // No unassign call in between — the assign endpoint itself vacates
    // wherever the principal already was.
    await assign(stationMoveBId, movePrincipalId);

    const [a, b] = await Promise.all([
      db.select({ principalId: stations.principalId }).from(stations).where(eq(stations.id, stationMoveAId)),
      db.select({ principalId: stations.principalId }).from(stations).where(eq(stations.id, stationMoveBId)),
    ]);
    expect(a[0]!.principalId, "the old station is empty").toBeNull();
    expect(b[0]!.principalId, "the principal is in exactly the new station").toBe(movePrincipalId);
  });

  test("P leaves X, Q takes X: Q's gate goes to Q's own room and is answered by @agent_Q — never P's room, never @agent_P", async () => {
    // P occupies X first, binding X's only room at the time (roomX1) to P.
    await assign(stationXId, pId);
    const roomX1Bound = await roomRow(roomX1);
    expect(roomX1Bound!.principalId, "P's assignment bound X's room to P").toBe(pId);

    // P moves on to Y — the move this whole slice is about. X is now empty.
    await assign(stationYId, pId);
    const xAfterPLeaves = await db.select({ principalId: stations.principalId }).from(stations).where(eq(stations.id, stationXId));
    expect(xAfterPLeaves[0]!.principalId).toBeNull();

    // Q takes X. X is already empty at this point (P vacated it the moment
    // it was assigned to Y, above) — nothing to evict here. Nothing at X is
    // bound to Q yet either — the admin route's bind-on-assign found no
    // unbound room to give it (roomX1, still P's, is not null), same as it
    // would in production the moment a station's room already belongs to a
    // departed occupant.
    await assign(stationXId, qId);
    expect((await roomRow(roomX1))!.principalId, "P's room is untouched by Q's assignment").toBe(pId);

    // THE REAL PROVISIONING PATH gives Q its own room — nothing here is
    // hand-inserted into `matrix_rooms`. A fix-round review named this
    // exactly: a test whose room is hand-seeded with a "simulating
    // provisioning" comment proves nothing about whether provisioning
    // actually works, and it did not — `provision.ts`'s own station->room
    // join had the identical unordered-[row] bug `roomForCard` was fixed
    // for, so a new occupant with no room of its own never got one. This
    // fails if that regresses.
    const ensuredRooms: string[] = [];
    await provisionStation(stationXId, {
      domain: "id.agentpod.dev",
      client: {
        ensureUser: async () => {},
        ensureRoom: async () => {
          ensuredRooms.push(roomX2);
          return roomX2;
        },
        invite: async () => {},
      },
    });
    expect(ensuredRooms, "a room was actually created for Q, not skipped").toHaveLength(1);
    expect((await roomRow(roomX2))!.principalId, "and bound to Q at creation").toBe(qId);

    // New work dispatched to X, now that Q occupies it.
    const cardId = `crd_${RUN}_q`;
    await db.insert(bridgeDispatches).values({
      externalSource: "kaambaan",
      externalRunId: `run_${RUN}_q`,
      tenantId: BOOTSTRAP_TENANT_ID,
      boardId: `brd_${RUN}`,
      externalCardId: cardId,
      agentKey: "test",
      stationId: stationXId,
      leaseEpoch: 1,
      outcome: "produced",
      startedAt: new Date(),
      updatedAt: new Date(),
    });

    const { deps, sent } = fakeDeps();
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, delivery(`gate_${RUN}_q`, cardId), deps);

    expect(outcome.status).toBe("sent");
    // Q's OWN room — never roomX1, which is P's.
    expect((outcome as { roomId: string }).roomId).toBe(roomX2);
    expect((outcome as { roomId: string }).roomId).not.toBe(roomX1);
    expect(sent.every((s) => s.roomId === roomX2)).toBe(true);
    // Posted as Q — never as P.
    const qHandleMxid = bridgeUserId(`${HANDLE_PREFIX}-q`, "id.agentpod.dev");
    const pHandleMxid = bridgeUserId(`${HANDLE_PREFIX}-p`, "id.agentpod.dev");
    expect(sent.every((s) => s.userId === qHandleMxid)).toBe(true);
    expect(sent.some((s) => s.userId === pHandleMxid)).toBe(false);

    // `station_id` is still populated on both rooms at X — the brief's
    // explicit negative, since the deployed sweep joins on it.
    expect((await roomRow(roomX1))!.stationId).toBe(stationXId);
    expect((await roomRow(roomX2))!.stationId).toBe(stationXId);

    // And each room still answers as its OWN bound resident, not the
    // station's current one.
    expect(await roomAgentUser(roomX1, "id.agentpod.dev")).toBe(pHandleMxid);
    expect(await roomAgentUser(roomX2, "id.agentpod.dev")).toBe(qHandleMxid);
  });

  test("assigning a station already held by a DIFFERENT principal evicts it — and that eviction is logged", async () => {
    // A genuine eviction, not a move: R already occupies Y (assigned above,
    // and never vacated by anything since), and S is assigned to Y directly
    // — nobody unassigned R first. R silently loses its station as a
    // consequence, which is legitimate (Ruling 6's "assign a different
    // agent" reassigns exactly this way) but must not be SILENT.
    const rId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-r` });
    const sId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-s` });
    const stationEvictId = `st_gra_evict_${RUN}`;
    await db.insert(stations).values({
      id: stationEvictId,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId: ADMIN_ACTOR,
      nodeId: sharedNodeId,
      harness: "opencode",
      stationKey: `opencode:${RUN}-evict`,
      kind: "workspace",
      displayName: "Station Evict",
    });

    await assign(stationEvictId, rId);
    const before = await db.select({ principalId: stations.principalId }).from(stations).where(eq(stations.id, stationEvictId));
    expect(before[0]!.principalId).toBe(rId);

    const warnSpy = spyOn(console, "warn");
    try {
      await assign(stationEvictId, sId);

      const after = await db.select({ principalId: stations.principalId }).from(stations).where(eq(stations.id, stationEvictId));
      expect(after[0]!.principalId, "S actually occupies the station now").toBe(sId);

      const evictionLogged = warnSpy.mock.calls.some(([line]) => {
        if (typeof line !== "string") return false;
        return (
          line.includes("evicted") &&
          line.includes(stationEvictId) &&
          line.includes(rId) &&
          line.includes(sId)
        );
      });
      expect(evictionLogged, "R's eviction from the station is logged, not silent").toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
