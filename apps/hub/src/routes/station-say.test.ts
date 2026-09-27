/**
 * Speaking unprompted — and never in the wrong room.
 *
 * Fix round 2 on Task 5. A review's second pass found this route making the
 * identical mistake `gates.ts`'s `roomForCard` was fixed for in round 1: a
 * bare `leftJoin(matrixRooms, eq(matrixRooms.stationId, stations.id))`, with
 * no `ORDER BY`, handed back an ARBITRARY room at a station's `station_id` —
 * which, once a station can carry more than one room, can belong to whoever
 * occupied it before. This route then spoke as the station's CURRENT
 * occupant into THAT room. P leaves a station, Q takes it: this route would
 * post `@agent_Q`'s words into `@agent_P`'s room, a room whose Matrix
 * membership belongs to P — a live route, unlike `roomForCard`, this was
 * never previously covered by a test at all.
 *
 * `station-room.ts`'s `roomForStation` is now the one place this resolves,
 * shared with `gates.ts` and `provision.ts`. This is the test that would have
 * caught the bug, and the one that proves it stays caught.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { db, rawSql } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { matrixRooms } from "../db/schema/matrix";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { createPrincipal } from "../services/principals";
import { adminMiddleware } from "../auth/admin-middleware";
import { agentsAdminRouter } from "./agents-admin";
import { createStationSayRoutes } from "./station-say";
import { bridgeUserId } from "../services/matrix-as/names";
import type { AuthUser } from "../auth/middleware";

const RUN = crypto.randomUUID().slice(0, 8);
const HANDLE_PREFIX = `station-say-it-${RUN}`;
const OWNER = `test-owner-station-say-${RUN}`;
const DOMAIN = "id.agentpod.dev";

let stationAId: string;
let pId: string;
let qId: string;
const roomA1 = `!say-a1-${RUN}:id.agentpod.dev`;
const roomA2 = `!say-a2-${RUN}:id.agentpod.dev`;

function adminApp() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: OWNER, authType: "api_key", tenantId: "default" });
    await next();
  });
  a.use("*", adminMiddleware);
  a.route("/", agentsAdminRouter);
  return a;
}

function sayApp(sent: Array<{ userId: string; roomId: string; body: string }>) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: OWNER } as AuthUser);
    await next();
  });
  a.route(
    "/",
    createStationSayRoutes({
      domain: DOMAIN,
      client: {
        sendText: async (userId: string, roomId: string, body: string) => {
          sent.push({ userId, roomId, body });
          return `$evt-${sent.length}`;
        },
      },
    })
  );
  return a;
}

const admin = adminApp();

async function assign(stationId: string, principalId: string) {
  const res = await admin.request(`/stations/${stationId}/agent`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId }),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  await ensurePgMigrations();

  await createTestUser({
    id: OWNER,
    email: `station-say-owner-${RUN}@example.com`,
    name: "Owner",
    role: "admin",
  });

  const { token } = await mintEnrollmentToken(OWNER);
  const { nodeId } = await enrollNode(token, {
    hostname: `station-say-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 1,
  });

  stationAId = `st_say_a_${RUN}`;
  await db.insert(stations).values({
    id: stationAId,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: OWNER,
    nodeId,
    harness: "opencode",
    stationKey: `opencode:${RUN}-a`,
    kind: "workspace",
    displayName: "Station A",
  });

  // P's own room — the ordinary case: a station provisioned once, for its
  // first occupant.
  await db.insert(matrixRooms).values({
    roomId: roomA1,
    tenantId: BOOTSTRAP_TENANT_ID,
    stationId: stationAId,
    alias: `#say-a1-${RUN}:${DOMAIN}`,
  });

  pId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-p` });
  qId = await createPrincipal({ kind: "agent", handle: `${HANDLE_PREFIX}-q` });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations WHERE user_id = ${OWNER}`;
    await rawSql`DELETE FROM nodes WHERE user_id = ${OWNER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${OWNER}`;
    await rawSql`DELETE FROM principals WHERE handle LIKE ${HANDLE_PREFIX + "%"}`;
    await rawSql`DELETE FROM "user" WHERE id = ${OWNER}`;
  } catch {
    // cleanup only
  }
});

describe("speaking unprompted reaches the CURRENT occupant's own room", () => {
  test("P leaves the station, Q takes it: this route speaks as Q, into Q's own room — never P's", async () => {
    // P occupies A first, binding room A1 — its OWN room, kept from here on.
    await assign(stationAId, pId);
    const [a1] = await db
      .select({ principalId: matrixRooms.principalId })
      .from(matrixRooms)
      .where(eq(matrixRooms.roomId, roomA1));
    expect(a1!.principalId).toBe(pId);

    // A second room turns up at the SAME station — what provisioning gives
    // the next occupant, since a departed occupant's room (A1) stays put
    // rather than being reused. Station A now genuinely carries two rooms,
    // the ordinary case since fix round 1 dropped uniqueness from
    // `matrix_rooms_station_idx`.
    await db.insert(matrixRooms).values({
      roomId: roomA2,
      tenantId: BOOTSTRAP_TENANT_ID,
      stationId: stationAId,
      alias: `#say-a2-${RUN}:${DOMAIN}`,
    });

    // Q takes A — evicting P (a station holds one occupant at a time). Room
    // A2, still unbound, is what binds to Q; room A1 stays P's, untouched.
    await assign(stationAId, qId);
    const [a1After, a2After] = await Promise.all([
      db.select({ principalId: matrixRooms.principalId }).from(matrixRooms).where(eq(matrixRooms.roomId, roomA1)),
      db.select({ principalId: matrixRooms.principalId }).from(matrixRooms).where(eq(matrixRooms.roomId, roomA2)),
    ]);
    expect(a1After[0]!.principalId, "P's room is untouched by Q's assignment").toBe(pId);
    expect(a2After[0]!.principalId).toBe(qId);

    const sent: Array<{ userId: string; roomId: string; body: string }> = [];
    const app = sayApp(sent);

    const res = await app.request(`/stations/${stationAId}/matrix/say`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "good morning" }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { roomId: string; mxid: string };

    const qMxid = bridgeUserId(`${HANDLE_PREFIX}-q`, DOMAIN);
    const pMxid = bridgeUserId(`${HANDLE_PREFIX}-p`, DOMAIN);

    // Q's OWN room — never P's, even though P's room still sits at this
    // exact `station_id`.
    expect(json.roomId).toBe(roomA2);
    expect(json.roomId).not.toBe(roomA1);
    expect(json.mxid).toBe(qMxid);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.roomId).toBe(roomA2);
    expect(sent[0]!.userId).toBe(qMxid);
    // The bug this test exists to catch: nothing sent as P, nowhere.
    expect(sent.some((s) => s.userId === pMxid || s.roomId === roomA1)).toBe(false);
  });
});
