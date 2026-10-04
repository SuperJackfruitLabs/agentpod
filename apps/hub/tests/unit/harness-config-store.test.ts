/**
 * What the fleet wants a harness setting to be — the hub's store half.
 *
 * `declare`/`undeclare`/`resolveFor` hold no opinion about what a station
 * currently has (that is observed live from the node, never cached here —
 * see the schema module doc). This suite only pins precedence: station beats
 * node beats fleet, a level replaces rather than duplicates, and a setting
 * nobody declared resolves to nothing rather than a default.
 *
 * `tenantId` and `declaredBy` are REQUIRED on every call — never made
 * optional to suit a test, because an optional tenant on a hub query is a
 * cross-tenant write.
 *
 * DATABASE_URL must point at the local Docker test-postgres on localhost:5434
 * (see TESTING.md). The preamble below is a documented no-op fallback — the
 * module that reads DATABASE_URL has already loaded by the time this runs;
 * the command-line override is what actually matters.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { declaredHarnessConfig } from "../../src/db/schema/harness-config";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { declare, undeclare, resolveFor } from "../../src/services/harness-config";

const SETTING = "hermes.approvals.timeout";
// The fixture tenant other hub unit tests use for rows that carry a real FK to
// `tenants` (tenants.id is CHECK-constrained to `fleet_<20 hex>`; `tnt_…` is
// superpipeline's id space and belongs to a different database).
const TENANT = BOOTSTRAP_TENANT_ID;
const WHO = "usr_test";

const fleet = { settingId: SETTING, stationId: null, nodeId: null, tenantId: TENANT, declaredBy: WHO };
const atNode = { ...fleet, nodeId: "node_1" };
const atStation = { ...fleet, stationId: "station_a" };
const resolved = async (station: string) => (await resolveFor(station, "node_1", TENANT))[SETTING];

describe("declared harness config", () => {
  beforeAll(async () => {
    await ensurePgMigrations();
  });

  beforeEach(async () => {
    await db.delete(declaredHarnessConfig).where(eq(declaredHarnessConfig.tenantId, TENANT));
  });

  test("the most specific declaration wins: station over node over fleet", async () => {
    await declare({ ...fleet, value: 300 });
    expect(await resolved("station_a")).toEqual({ value: 300, level: "fleet" });

    await declare({ ...atNode, value: 600 });
    expect(await resolved("station_a")).toEqual({ value: 600, level: "node" });

    await declare({ ...atStation, value: 900 });
    expect(await resolved("station_a")).toEqual({ value: 900, level: "station" });

    // A sibling on the same node still gets the node's value, not the station's.
    expect(await resolved("station_b")).toEqual({ value: 600, level: "node" });
  });

  test("declaring twice at one level replaces rather than duplicates", async () => {
    await declare({ ...fleet, value: 300 });
    await declare({ ...fleet, value: 900 });
    expect(await resolved("station_a")).toEqual({ value: 900, level: "fleet" });
  });

  test("undeclaring a level falls back to the next one out", async () => {
    await declare({ ...fleet, value: 300 });
    await declare({ ...atStation, value: 900 });
    await undeclare({ ...atStation });
    expect(await resolved("station_a")).toEqual({ value: 300, level: "fleet" });
  });

  test("nothing declared resolves to nothing — never to a default", async () => {
    expect(await resolveFor("station_a", "node_1", TENANT)).toEqual({});
  });
});
