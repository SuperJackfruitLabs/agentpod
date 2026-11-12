/**
 * The roster read for Superlibrary, and the invalidation when a bridge row changes.
 *
 * DATABASE_URL must point at a test Postgres (CI: localhost:5434).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "bridge-roster-test-key-0123456789";

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { bridgeAgents, bridgeDispatches } from "../../src/db/schema/bridge";
import { stations } from "../../src/db/schema/stations";
import { nodes } from "../../src/db/schema/nodes";
import { BOOTSTRAP_TENANT_ID as TENANT, tenants } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { boardRosterFor, rosterBoardsFor, stationOwnerFor } from "../../src/routes/bridge-roster";
import {
  createBridgeAgent,
  deleteBridgeAgent,
  notifyRosterChanged,
  updateBridgeAgent,
} from "../../src/services/bridge/roster";
import { setSuperlibraryClientForTests } from "../../src/services/superlibrary/client";

const NODE_ID = "node_roster_endpoint_test";
const S1 = "station_roster_endpoint_1";
const S2 = "station_roster_endpoint_2";
const S3 = "station_roster_endpoint_3";
const OTHER_TENANT = "fleet_0000000000000000c0d1";
const OTHER_NODE = "node_roster_endpoint_other";
const AGENT = "prn_000000000000000000a2";
const OTHER = "prn_000000000000000000a3";
const B1 = "brd_00000000000000b1";
const B2 = "brd_00000000000000b2";
const B3 = "brd_00000000000000b3";
const TOKEN = `spa_${"a1b2c3d4".repeat(6)}`;

let userId: string;
let ownerId: string;
let seen: string[];
let restore: () => void;

const flush = () => new Promise((r) => setTimeout(r, 50));
const row = (key: string, boardId: string, stationId: string, enabled = true) => ({
  tenantId: TENANT,
  key,
  boardId,
  stationId,
  token: TOKEN,
  enabled,
});

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "roster-endpoint" })).id;
  await db
    .insert(nodes)
    .values({
      id: NODE_ID, tenantId: TENANT, userId, name: "roster-endpoint-node",
      hostname: "roster-endpoint.test", os: "linux", arch: "arm64", status: "offline", secretHash: "x",
    })
    .onConflictDoNothing();
  ownerId = userId;
  await db.insert(tenants).values({ id: OTHER_TENANT, name: "roster endpoint other tenant" }).onConflictDoNothing();
  await db
    .insert(nodes)
    .values({
      id: OTHER_NODE, tenantId: OTHER_TENANT, userId, name: "roster-endpoint-other-node",
      hostname: "roster-endpoint-other.test", os: "linux", arch: "arm64", status: "offline", secretHash: "x",
    })
    .onConflictDoNothing();
  await db
    .insert(stations)
    .values({
      id: S3, tenantId: OTHER_TENANT, userId, nodeId: OTHER_NODE, harness: "hermes",
      stationKey: `${S3}-key`, kind: "service", displayName: S3,
    })
    .onConflictDoNothing();
  for (const [id, principalId] of [[S1, AGENT], [S2, OTHER]] as const) {
    await db
      .insert(stations)
      .values({
        id, tenantId: TENANT, userId, nodeId: NODE_ID, harness: "hermes",
        stationKey: `${id}-key`, kind: "service", displayName: id, principalId,
      })
      .onConflictDoNothing();
  }
});

beforeEach(async () => {
  await db.delete(bridgeDispatches).where(inArray(bridgeDispatches.stationId, [S1, S2, S3]));
  await db.delete(bridgeAgents).where(inArray(bridgeAgents.stationId, [S1, S2]));
  seen = [];
  restore = setSuperlibraryClientForTests({
    asService: () => { throw new Error("unused"); },
    asAgent: () => { throw new Error("unused"); },
    warmAgent: async () => {},
    invalidateRoster: async (p) => { seen.push(p); },
  });
});
afterEach(() => restore());

afterAll(async () => {
  await db.delete(bridgeDispatches).where(inArray(bridgeDispatches.stationId, [S1, S2, S3]));
  await db.delete(bridgeAgents).where(inArray(bridgeAgents.stationId, [S1, S2]));
  await db.delete(stations).where(inArray(stations.id, [S1, S2]));
  await db.delete(stations).where(eq(stations.id, S3));
  await db.delete(nodes).where(inArray(nodes.id, [NODE_ID, OTHER_NODE]));
  await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT));
});

test("enabled rows on the principal's station only", async () => {
  await createBridgeAgent(row("a-b1", B1, S1));
  await createBridgeAgent(row("a-b2", B2, S1, false));
  await createBridgeAgent(row("o-b3", B3, S2));
  await createBridgeAgent(row("a-b1-again", B1, S1));
  expect(await rosterBoardsFor(TENANT, AGENT)).toEqual([B1]);
  expect(await rosterBoardsFor(TENANT, OTHER)).toEqual([B3]);
  expect(await rosterBoardsFor(TENANT, "prn_000000000000000000a9")).toEqual([]);
  expect(await rosterBoardsFor("fleet_99999999999999999999", AGENT)).toEqual([]);
});

test("notifyRosterChanged tells Superlibrary the station principal's roster changed", async () => {
  await notifyRosterChanged(TENANT, S1);
  expect(seen).toEqual([AGENT]);
});

test("notifyRosterChanged never throws, and does nothing without a client", async () => {
  restore();
  restore = setSuperlibraryClientForTests({
    asService: () => { throw new Error("unused"); },
    asAgent: () => { throw new Error("unused"); },
    warmAgent: async () => {},
    invalidateRoster: async () => { throw new Error("down"); },
  });
  await notifyRosterChanged(TENANT, S1);
  restore();
  restore = setSuperlibraryClientForTests(null);
  await notifyRosterChanged(TENANT, S1);
});

test("creating, updating and deleting a bridge row each invalidate", async () => {
  await createBridgeAgent(row("w1", B1, S1));
  await flush();
  expect(seen).toEqual([AGENT]);

  seen.length = 0;
  await updateBridgeAgent(TENANT, "w1", { enabled: false });
  await flush();
  expect(seen).toEqual([AGENT]);

  seen.length = 0;
  await updateBridgeAgent(TENANT, "w1", { stationId: S2 });
  await flush();
  expect(seen.sort()).toEqual([AGENT, OTHER].sort());

  seen.length = 0;
  await deleteBridgeAgent(TENANT, "w1");
  await flush();
  expect(seen).toEqual([OTHER]);

  seen.length = 0;
  expect(await deleteBridgeAgent(TENANT, "w1")).toBe(false);
  await flush();
  expect(seen).toEqual([]);
});

test("stationOwnerFor reads only the caller's tenant", async () => {
  expect(await stationOwnerFor(TENANT, S1)).toEqual({ id: S1, key: `${S1}-key`, owner: ownerId });
  expect(await stationOwnerFor(OTHER_TENANT, S1)).toBeNull();
  expect(await stationOwnerFor(TENANT, S3)).toBeNull();
  expect(await stationOwnerFor(OTHER_TENANT, S3)).toEqual({ id: S3, key: `${S3}-key`, owner: ownerId });
});

const dispatch = (runId: string, stationId: string, outcome: string, startedAt: string, tenantId = TENANT) => ({
  externalSource: "superpipeline",
  externalRunId: runId,
  tenantId,
  boardId: B2,
  externalCardId: "card_0000000000000001",
  agentKey: "any",
  stationId,
  leaseEpoch: 1,
  outcome,
  startedAt: new Date(startedAt),
  updatedAt: new Date(startedAt),
});

test("boardRosterFor lists the board's rows with each station's work on any board", async () => {
  await createBridgeAgent(row("a-b1", B1, S1));
  await createBridgeAgent(row("o-b1", B1, S2, false));
  await createBridgeAgent(row("a-b2", B2, S1));
  // S1 has a run in hand on another board, and took an earlier one; S2's only run is done.
  await db.insert(bridgeDispatches).values([
    dispatch("run_roster_1", S1, "reported", "2026-11-12T09:00:00.000Z"),
    dispatch("run_roster_2", S1, "working", "2026-11-12T10:00:00.000Z"),
    dispatch("run_roster_3", S2, "reported", "2026-11-12T08:00:00.000Z"),
    // Another tenant's run on a station id this tenant does not have counts for nobody here.
    dispatch("run_roster_4", S3, "working", "2026-11-12T11:00:00.000Z", OTHER_TENANT),
  ]);
  expect(await boardRosterFor(TENANT, B1)).toEqual([
    { key: "a-b1", stationId: S1, principalId: AGENT, enabled: true, busy: true, lastDispatchedAt: "2026-11-12T10:00:00.000Z" },
    { key: "o-b1", stationId: S2, principalId: OTHER, enabled: false, busy: false, lastDispatchedAt: "2026-11-12T08:00:00.000Z" },
  ]);
  expect(await boardRosterFor(TENANT, B3)).toEqual([]);
  expect(await boardRosterFor(OTHER_TENANT, B1)).toEqual([]);
});

test("only a working run is work in hand; a parked, released, abandoned or reported one is not", async () => {
  await createBridgeAgent(row("a-b1", B1, S1));
  await db.insert(bridgeDispatches).values([
    dispatch("run_roster_5", S1, "released", "2026-11-12T09:00:00.000Z"),
    dispatch("run_roster_6", S1, "abandoned", "2026-11-12T09:10:00.000Z"),
    dispatch("run_roster_8", S1, "reported", "2026-11-12T09:15:00.000Z"),
    // #786: a parked run no longer holds the roster; the bridge claims new work beside it.
    dispatch("run_roster_7", S1, "parked", "2026-11-12T09:20:00.000Z"),
  ]);
  const [entry] = await boardRosterFor(TENANT, B1);
  expect(entry?.busy).toBe(false);
  // Still the last time the station took work.
  expect(entry?.lastDispatchedAt).toBe("2026-11-12T09:20:00.000Z");
  await db.insert(bridgeDispatches).values(dispatch("run_roster_9", S1, "working", "2026-11-12T09:30:00.000Z"));
  expect((await boardRosterFor(TENANT, B1))[0]?.busy).toBe(true);
});
