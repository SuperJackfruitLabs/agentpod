/**
 * Integration Test: the opt-out register has two levels, and no duplicates
 * at either one.
 *
 * `harness_config_opt_out` shipped with `station_key NOT NULL` and
 * `unique(tenant_id, station_key, setting_id)` — station-level only. This
 * task makes `station_key` nullable so a row can instead name a `node_id`
 * (D9: there is no fleet level here — `fleet config unset` already covers
 * that case), while keeping duplicates impossible at both levels.
 *
 * The trap: Postgres treats NULL as distinct from NULL, so the moment
 * `station_key` can be null, the shipped unique constraint stops catching
 * duplicate NODE-level rows — two rows with `station_key IS NULL` for the
 * same `(tenant, node, setting)` both insert under a plain unique
 * constraint. This exact defect hit `declared_harness_config` in an earlier
 * plan and needed a partial unique index (`declared_cfg_fleet`); this file's
 * third test is the regression test for the same defect here.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

// src/ imports — DB URL is already set above
import { rawSql } from "../../src/db/drizzle";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { setOptOut, clearOptOut, resolveOptOuts, listOptOuts } from "../../src/services/harness-config";

// ─── Constants ────────────────────────────────────────────────────────────────

// A real AgentPod tenant id (`fleet_<20 hex>`) — "tnt_test" fails the
// `tenants_id_is_agentpod_fleet` CHECK constraint at insert.
const TENANT_ID = "fleet_c0f9014400000000001a";
// A second tenant, used only by the cross-tenant isolation test below —
// never shares a row with TENANT_ID.
const TENANT_ID_2 = "fleet_c0f9014400000000002b";
const TEST_USER = "test-user-cfgoptlvl-001";
const SETTING = "hermes.approvals.timeout";

function rid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function insertOptOut(row: {
  stationKey?: string | null;
  nodeId?: string | null;
  settingId?: string;
  id?: string;
}): Promise<string> {
  const id = row.id ?? rid("cfgoo");
  await rawSql`
    INSERT INTO harness_config_opt_out
      (id, tenant_id, station_key, node_id, setting_id, opted_out, opted_out_by)
    VALUES
      (${id}, ${TENANT_ID}, ${row.stationKey ?? null}, ${row.nodeId ?? null},
       ${row.settingId ?? SETTING}, true, ${TEST_USER})
  `;
  return id;
}

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`
    INSERT INTO tenants (id, name) VALUES (${TENANT_ID}, 'Opt-out levels test')
    ON CONFLICT (id) DO NOTHING
  `;
  await rawSql`
    INSERT INTO tenants (id, name) VALUES (${TENANT_ID_2}, 'Opt-out levels test (other tenant)')
    ON CONFLICT (id) DO NOTHING
  `;
  await rawSql`
    INSERT INTO "user" (id, email, name, email_verified, role, created_at, updated_at)
    VALUES (${TEST_USER}, 'cfgoptlvl-test@example.com', 'Opt-out Levels Test User', true, 'user', now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM applied_harness_config WHERE tenant_id IN (${TENANT_ID}, ${TENANT_ID_2})`;
    await rawSql`DELETE FROM harness_config_opt_out  WHERE tenant_id IN (${TENANT_ID}, ${TENANT_ID_2})`;
    await rawSql`DELETE FROM stations                WHERE tenant_id = ${TENANT_ID}`;
    await rawSql`DELETE FROM nodes                    WHERE tenant_id = ${TENANT_ID}`;
    await rawSql`DELETE FROM "user"                  WHERE id = ${TEST_USER}`;
    await rawSql`DELETE FROM tenants                  WHERE id IN (${TENANT_ID}, ${TENANT_ID_2})`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helpers for the FK test ───────────────────────────────────────────────────

async function createStationFixture(suffix: string): Promise<{ stationId: string; nodeId: string }> {
  const nodeId = rid(`node-${suffix}`);
  const stationId = rid(`stn-${suffix}`);
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, secret_hash)
    VALUES (${nodeId}, ${TENANT_ID}, ${TEST_USER}, ${"node-" + suffix}, ${"host-" + suffix}, 'linux', 'amd64', 'fake-hash')
  `;
  await rawSql`
    INSERT INTO stations
      (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name)
    VALUES
      (${stationId}, ${TENANT_ID}, ${TEST_USER}, ${nodeId}, 'hermes', ${"station-key-" + suffix}, 'leaf', ${"Station " + suffix})
  `;
  return { stationId, nodeId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("the opt-out register has two levels and no duplicates", () => {
  test("a station row and a node row for the same setting coexist", async () => {
    const stationKey = "coexist-station";
    const nodeId = "coexist-node";

    await insertOptOut({ stationKey, nodeId: null, settingId: SETTING });
    await insertOptOut({ stationKey: null, nodeId, settingId: SETTING });

    const rows = await rawSql`
      SELECT station_key, node_id FROM harness_config_opt_out
      WHERE tenant_id = ${TENANT_ID} AND setting_id = ${SETTING}
        AND (station_key = ${stationKey} OR node_id = ${nodeId})
    `;
    expect(rows.length).toBe(2);
  });

  test("two station rows for the same (tenant, station, setting) cannot both exist", async () => {
    const stationKey = "dup-station";
    await insertOptOut({ stationKey, nodeId: null, settingId: SETTING });

    await expect(insertOptOut({ stationKey, nodeId: null, settingId: SETTING })).rejects.toThrow();
  });

  test("two NODE rows for the same (tenant, node, setting) cannot both exist", async () => {
    // THE REGRESSION THIS TASK EXISTS TO PREVENT. With station_key NULL on
    // both rows, a plain unique constraint over nullable columns does not
    // conflict and both insert.
    const nodeId = "dup-node";
    await insertOptOut({ stationKey: null, nodeId, settingId: SETTING });

    await expect(insertOptOut({ stationKey: null, nodeId, settingId: SETTING })).rejects.toThrow();
  });

  test("a row with neither station nor node is refused", async () => {
    await expect(insertOptOut({ stationKey: null, nodeId: null, settingId: SETTING })).rejects.toThrow();
  });

  test("a row with BOTH station and node is refused", async () => {
    await expect(
      insertOptOut({ stationKey: "both-station", nodeId: "both-node", settingId: SETTING }),
    ).rejects.toThrow();
  });

  test("deleting a station row leaves the node row untouched", async () => {
    const stationKey = "leave-alone-station";
    const nodeId = "leave-alone-node";
    const stationRowId = await insertOptOut({ stationKey, nodeId: null, settingId: SETTING });
    const nodeRowId = await insertOptOut({ stationKey: null, nodeId, settingId: SETTING });

    await rawSql`DELETE FROM harness_config_opt_out WHERE id = ${stationRowId}`;

    const remaining = await rawSql`
      SELECT id FROM harness_config_opt_out WHERE id = ${nodeRowId}
    `;
    expect(remaining.length).toBe(1);

    const gone = await rawSql`
      SELECT id FROM harness_config_opt_out WHERE id = ${stationRowId}
    `;
    expect(gone.length).toBe(0);
  });

  test("deleting a station removes its applied_harness_config rows (FK cascade)", async () => {
    const { stationId, nodeId } = await createStationFixture("cascade");

    await rawSql`
      INSERT INTO applied_harness_config (id, tenant_id, station_id, setting_id, value)
      VALUES (${rid("acfg")}, ${TENANT_ID}, ${stationId}, ${SETTING}, '"900"'::jsonb)
    `;

    const before = await rawSql`SELECT id FROM applied_harness_config WHERE station_id = ${stationId}`;
    expect(before.length).toBe(1);

    await rawSql`DELETE FROM stations WHERE id = ${stationId}`;

    const after = await rawSql`SELECT id FROM applied_harness_config WHERE station_id = ${stationId}`;
    expect(after.length).toBe(0);

    await rawSql`DELETE FROM nodes WHERE id = ${nodeId}`;
  });
});

// ─── resolveOptOuts: most-specific-first ──────────────────────────────────────

describe("resolveOptOuts resolves most-specific-first", () => {
  test("a station row optedOut=true exempts the setting", async () => {
    const stationKey = "resolve-station-true";
    const nodeId = "resolve-node-for-station-true";

    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: true, stationKey, optedOutBy: TEST_USER });

    const out = await resolveOptOuts(TENANT_ID, stationKey, nodeId);
    expect(out.has(SETTING)).toBe(true);
  });

  test("a node row optedOut=true exempts every station on that node", async () => {
    const nodeId = "resolve-node-true";

    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: true, nodeId, optedOutBy: TEST_USER });

    const stationA = await resolveOptOuts(TENANT_ID, "resolve-station-a-on-node", nodeId);
    const stationB = await resolveOptOuts(TENANT_ID, "resolve-station-b-on-node", nodeId);
    expect(stationA.has(SETTING)).toBe(true);
    expect(stationB.has(SETTING)).toBe(true);
  });

  test("a station row optedOut=FALSE overrides a node row optedOut=true", async () => {
    const stationKey = "resolve-station-override";
    const nodeId = "resolve-node-overridden";

    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: true, nodeId, optedOutBy: TEST_USER });
    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: false, stationKey, optedOutBy: TEST_USER });

    const out = await resolveOptOuts(TENANT_ID, stationKey, nodeId);
    expect(out.has(SETTING)).toBe(false);

    // A sibling station on the same node, with no station-level row of its
    // own, is still exempt — the override is specific to THIS station, not
    // the node's rule itself.
    const sibling = await resolveOptOuts(TENANT_ID, "resolve-station-sibling", nodeId);
    expect(sibling.has(SETTING)).toBe(true);
  });

  test("no row at either level means not exempt", async () => {
    const out = await resolveOptOuts(TENANT_ID, "resolve-station-none", "resolve-node-none");
    expect(out.has(SETTING)).toBe(false);
  });

  test("deleting the station row falls back to the node row (absence is not false)", async () => {
    const stationKey = "resolve-station-fallback";
    const nodeId = "resolve-node-fallback";

    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: true, nodeId, optedOutBy: TEST_USER });
    await setOptOut({ tenantId: TENANT_ID, settingId: SETTING, optedOut: false, stationKey, optedOutBy: TEST_USER });
    expect((await resolveOptOuts(TENANT_ID, stationKey, nodeId)).has(SETTING)).toBe(false);

    const cleared = await clearOptOut({ tenantId: TENANT_ID, settingId: SETTING, stationKey });
    expect(cleared.cleared).toBe(true);

    // The station's "not exempt" was deleted, not flipped to true — the
    // node's rule is what the station now falls back to.
    expect((await resolveOptOuts(TENANT_ID, stationKey, nodeId)).has(SETTING)).toBe(true);
  });

  test("resolveOptOuts returns only ids for THIS station and THIS node, never another tenant's", async () => {
    const stationKey = "resolve-station-tenant-isolation";
    const nodeId = "resolve-node-tenant-isolation";

    await setOptOut({ tenantId: TENANT_ID_2, settingId: SETTING, optedOut: true, stationKey, optedOutBy: TEST_USER });

    const out = await resolveOptOuts(TENANT_ID, stationKey, nodeId);
    expect(out.has(SETTING)).toBe(false);
  });

  test("setOptOut twice for the same level updates rather than duplicating", async () => {
    const stationKey = "resolve-station-upsert";

    await setOptOut({
      tenantId: TENANT_ID, settingId: SETTING, optedOut: true, stationKey, optedOutBy: TEST_USER, reason: "first",
    });
    await setOptOut({
      tenantId: TENANT_ID, settingId: SETTING, optedOut: true, stationKey, optedOutBy: TEST_USER, reason: "second",
    });

    const rows = await listOptOuts(TENANT_ID, { stationKey });
    const matching = rows.filter((r) => r.settingId === SETTING);
    expect(matching.length).toBe(1);
    expect(matching[0]?.reason).toBe("second");
  });

  test("clearOptOut reports cleared:false when there was nothing to clear", async () => {
    const result = await clearOptOut({
      tenantId: TENANT_ID, settingId: SETTING, stationKey: "resolve-station-nothing-to-clear",
    });
    expect(result.cleared).toBe(false);
  });
});
