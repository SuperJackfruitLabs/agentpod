/**
 * Plan P3: where a linked file belongs, read from the hub's own tables.
 *
 * The open dispatch's board, card and run; else the station's one enabled board; else nothing.
 * The station and tenant asked about are the only ones ever read: a dispatch on another station
 * or in another tenant never lends its board (spec §15 "an agent cannot link another station's
 * file", on the provenance side).
 *
 * DATABASE_URL must point at a pgvector test Postgres (root CLAUDE.md).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { bridgeAgents, bridgeDispatches } from "../../src/db/schema/bridge";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID, tenants } from "../../src/db/schema/tenants";
import { stationProvenance } from "../../src/services/superlibrary/provenance";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const TENANT = BOOTSTRAP_TENANT_ID;
const OTHER_TENANT = "fleet_000000000000000000a6";
const NODE = "node_superlibrary_provenance";
const S = "station_superlibrary_prov_s";
const T = "station_superlibrary_prov_t";
const B1 = "brd_00000000000000b1";
const B2 = "brd_00000000000000b2";
const NO_BOARD = { refused: "This station is not on exactly one board, so the file has nowhere to belong. Link it while working a card." };

beforeAll(async () => {
  await ensurePgMigrations();
  const userId = (await createTestUser({ name: "superlibrary-provenance" })).id;
  await db.insert(tenants).values({ id: OTHER_TENANT, name: "provenance other tenant" }).onConflictDoNothing();
  await db.insert(nodes).values({
    id: NODE, tenantId: TENANT, userId, name: "superlibrary-provenance-node", hostname: "provenance.test",
    os: "linux", arch: "arm64", status: "online", secretHash: "x",
  }).onConflictDoNothing();
  for (const [id, key] of [[S, "prov-s"], [T, "prov-t"]] as const) {
    await db.insert(stations).values({
      id, tenantId: TENANT, userId, nodeId: NODE, harness: "hermes", stationKey: key, kind: "service", displayName: key,
    }).onConflictDoNothing();
  }
});

async function clean() {
  await db.delete(bridgeDispatches).where(inArray(bridgeDispatches.stationId, [S, T]));
  await db.delete(bridgeAgents).where(inArray(bridgeAgents.stationId, [S, T]));
}
beforeEach(clean);
afterAll(async () => {
  await clean();
  await db.delete(stations).where(inArray(stations.id, [S, T]));
  await db.delete(nodes).where(inArray(nodes.id, [NODE]));
  await db.delete(tenants).where(inArray(tenants.id, [OTHER_TENANT]));
});

let n = 0;
async function dispatch(o: { station?: string; tenant?: string; board?: string; card?: string; run?: string; outcome?: string; startedAt?: Date }) {
  n++;
  const at = o.startedAt ?? new Date();
  await db.insert(bridgeDispatches).values({
    externalSource: "superpipeline",
    externalRunId: o.run ?? `run_${n.toString(16).padStart(16, "0")}`,
    tenantId: o.tenant ?? TENANT,
    boardId: o.board ?? B1,
    externalCardId: o.card ?? `card_${n.toString(16).padStart(16, "0")}`,
    agentKey: "prov-agent",
    stationId: o.station ?? S,
    leaseEpoch: 1,
    outcome: o.outcome ?? "working",
    startedAt: at,
    updatedAt: at,
  });
}
async function rostered(board: string, o: { station?: string; enabled?: boolean } = {}) {
  n++;
  await db.insert(bridgeAgents).values({
    tenantId: TENANT, key: `prov-agent-${n}`, boardId: board, stationId: o.station ?? S, tokenEncrypted: "x", enabled: o.enabled ?? true,
  });
}

test("an open dispatch gives board, card and run", async () => {
  await rostered(B2);
  await dispatch({ board: B1, card: "card_00000000000000c1", run: "run_00000000000000d1" });
  expect(await stationProvenance(S, TENANT)).toEqual({ board: B1, card: "card_00000000000000c1", run: "run_00000000000000d1" });
});

test("a produced dispatch is still open; the newest open one wins", async () => {
  await dispatch({ board: B1, card: "card_00000000000000c1", run: "run_00000000000000d1", outcome: "produced", startedAt: new Date(Date.now() - 60_000) });
  await dispatch({ board: B2, card: "card_00000000000000c2", run: "run_00000000000000d2", outcome: "working", startedAt: new Date() });
  await dispatch({ board: B1, card: "card_00000000000000c3", run: "run_00000000000000d3", outcome: "working", startedAt: new Date(Date.now() - 120_000) });
  expect(await stationProvenance(S, TENANT)).toEqual({ board: B2, card: "card_00000000000000c2", run: "run_00000000000000d2" });
});

test("a finished dispatch is not open: reported, released and abandoned fall back to the roster", async () => {
  for (const outcome of ["reported", "released", "abandoned"]) await dispatch({ board: B2, outcome });
  await rostered(B1);
  expect(await stationProvenance(S, TENANT)).toEqual({ board: B1 });
});

test("no open dispatch and one board gives the board alone", async () => {
  await rostered(B1);
  await rostered(B1); // two agents on the same board are still one board
  await rostered(B2, { enabled: false }); // a stopped agent does not count
  expect(await stationProvenance(S, TENANT)).toEqual({ board: B1 });
});

test("two boards and no open dispatch is refused", async () => {
  await rostered(B1);
  await rostered(B2);
  expect(await stationProvenance(S, TENANT)).toEqual(NO_BOARD);
});

test("no board at all is refused", async () => {
  expect(await stationProvenance(S, TENANT)).toEqual(NO_BOARD);
});

test("a dispatch on another station is never used", async () => {
  await dispatch({ station: T, board: B1, card: "card_00000000000000c1", run: "run_00000000000000d1" });
  await rostered(B1, { station: T });
  expect(await stationProvenance(S, TENANT)).toEqual(NO_BOARD);
});

test("a dispatch in another tenant is never used", async () => {
  await dispatch({ tenant: OTHER_TENANT, board: B1 });
  await rostered(B2);
  expect(await stationProvenance(S, TENANT)).toEqual({ board: B2 });
  expect(await stationProvenance(S, OTHER_TENANT)).toEqual(expect.objectContaining({ board: B1 }));
});
