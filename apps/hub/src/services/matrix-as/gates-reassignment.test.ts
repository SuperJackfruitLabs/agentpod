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
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
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
import type { GatePendingDelivery } from "./gates";

const RUN = crypto.randomUUID().slice(0, 8);
const HANDLE_PREFIX = `gates-reassign-${RUN}`;
const ADMIN_ACTOR = `test-admin-actor-gates-reassign-${RUN}`;

let stationAId: string;
let stationBId: string;
let principalId: string;

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
    await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${stationAId}, ${stationBId})`;
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
        return `$prose-${sent.length}`;
      },
      sendCustomEvent: async (userId: string, roomId: string) => {
        sent.push({ userId, roomId });
        return `$gate-${sent.length}`;
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
