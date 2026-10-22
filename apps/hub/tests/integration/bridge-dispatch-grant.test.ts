/** Plan step 10 (spec 2026-10-23): the bridge's user gets the dispatch grant its runs need. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import {
  checkBridgeDispatchGrant,
  ensureBridgeDispatchGrant,
  type DispatchGrantDeps,
} from "../../src/services/bridge/dispatch-grant";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const tenantId = "fleet_" + hex(), nodeId = "node_" + hex();
const staffed = "station_" + hex(), empty = "station_" + hex(), byToken = "station_" + hex();
const adopter = "prn_" + hex(), agent = "prn_" + hex();

type P = { id: string; kind: "human" | "agent"; grant: { mayDispatch: string[]; mayGrantReach: boolean; scopes: string[] } | null };
function plane(people: P[]) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const grants: [string, string][] = [];
  const deps: DispatchGrantDeps = {
    directory: () => ({ principal: async (id: string) => (byId.get(id) ?? null) as never, invalidate: () => {} }),
    grant: async (h, a) => {
      grants.push([h, a]);
      byId.get(h)!.grant!.mayDispatch.push(a);
    },
  };
  return { deps, grants };
}

beforeAll(async () => {
  await ensurePgMigrations();
  await db.insert(tenants).values({ id: tenantId, name: "grant proof" });
  await db.insert(nodes).values({ id: nodeId, tenantId, userId: adopter, name: "n", hostname: "h", os: "t", arch: "t", secretHash: "x" });
  const row = (id: string, userId: string, principalId: string | null) => ({
    id, tenantId, userId, nodeId, harness: "salaam", stationKey: "salaam:" + id.slice(-16), kind: "leaf",
    displayName: "s", workspacePath: "/w/" + id, capabilities: ["acp"], principalId,
  });
  await db.insert(stations).values([row(staffed, adopter, agent), row(empty, adopter, null), row(byToken, "default-user", agent + "x")]);
});
afterAll(async () => {
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

test("a missing grant is recorded for the station's adopter over its own agent, once", async () => {
  const { deps, grants } = plane([{ id: adopter, kind: "human", grant: { mayDispatch: ["prn_other"], mayGrantReach: false, scopes: [] } }]);
  expect(await checkBridgeDispatchGrant(tenantId, staffed, deps)).toEqual({ state: "missing", adopter, agent });
  expect(await ensureBridgeDispatchGrant(tenantId, staffed, deps)).toEqual({ state: "granted", adopter, agent });
  expect(grants).toEqual([[adopter, agent]]);
  // Idempotent: the second call finds it and writes nothing.
  expect(await ensureBridgeDispatchGrant(tenantId, staffed, deps)).toEqual({ state: "present", adopter, agent });
  expect(grants).toHaveLength(1);
});

test("nothing is granted for an unstaffed station, a non-person adopter, or another workspace", async () => {
  const { deps, grants } = plane([{ id: adopter, kind: "human", grant: null }]);
  expect(await ensureBridgeDispatchGrant(tenantId, empty, deps)).toEqual({ state: "no_agent" });
  expect(await ensureBridgeDispatchGrant(tenantId, byToken, deps)).toEqual({ state: "adopter_not_a_person", adopter: "default-user" });
  expect(await ensureBridgeDispatchGrant("fleet_" + hex(), staffed, deps)).toEqual({ state: "no_agent" });
  expect(grants).toEqual([]);
});

test("a plane failure is reported, not thrown, so the roster write still stands", async () => {
  const { deps } = plane([{ id: adopter, kind: "human", grant: { mayDispatch: [], mayGrantReach: false, scopes: [] } }]);
  deps.grant = async () => {
    throw new Error("plane refused");
  };
  expect(await ensureBridgeDispatchGrant(tenantId, staffed, deps)).toEqual({ state: "unknown", reason: "plane refused" });
});
