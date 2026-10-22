import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { db } from "../../src/db/drizzle";
import { TENANT_SCOPED_TABLES } from "../../src/db/tenant-scope";
import { stationForgeApiGrants } from "../../src/db/schema/forge-api-grants";
import { nextGeneration } from "../../src/services/forge-api/generation";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";

/**
 * station_forge_api_grants against Postgres: live uniqueness keys on the station-id SNAPSHOT, the
 * station FK nulls on deletion (a grant outlives its station), CHECKs guard the vocabularies, and
 * generation never resets. Ruling 2026-10-17: stationId is nullable/set null, not restrict.
 */

// The ForgeGrantRef structural assertion lives in src/db/schema/forge-api-grants.typecheck.ts (tsc covers src only).

const OWNER = "test-user-fga-owner";
const NODE = "node_fga_schema";
const ST_A = "station_fga_a";
const ST_B = "station_fga_b";
const ST_DEL = "station_fga_del";
const ST_DEL2 = "station_fga_del2";
const ST_GEN = "station_fga_gen";
const LIVE_IDX = "station_forge_api_grants_live_idx";
const FORGE = "https://forge.example.test";

let tenant: string;
let seq = 0;

async function addStation(id: string) {
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${id}, ${tenant}, ${OWNER}, ${NODE}, 'claude-code', ${"claude-code:" + id}, 'leaf', ${id}, '["acp"]'::jsonb, now(), now())`;
}

async function grant(over: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: `fga_${Date.now()}_${seq++}`,
    tenantId: tenant,
    stationId: ST_A,
    stationIdSnapshot: ST_A,
    provider: "forgejo",
    instance: FORGE,
    mode: "minted",
    account: "agent-x",
    repositories: ["org/repo"],
    preset: "read",
    state: "authorised",
    generation: 1,
    createdBy: OWNER,
    ...over,
  };
  await db.insert(stationForgeApiGrants).values(row as never);
  return row.id as string;
}

/** The Postgres constraint a rejected insert violated (drizzle wraps the driver error as `cause`). */
async function violated(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const c = ((e as { cause?: { constraint_name?: string; constraint?: string } }).cause ?? e) as {
      constraint_name?: string;
      constraint?: string;
    };
    return c.constraint_name ?? c.constraint ?? "unknown";
  }
  return "none";
}

async function setState(id: string, state: string) {
  await rawSql`UPDATE station_forge_api_grants
    SET state = ${state}, revoked_at = CASE WHEN ${state} = 'revoked' THEN now() ELSE NULL END, updated_at = now() WHERE id = ${id}`;
}

const clean = async () => {
  await rawSql`DELETE FROM station_forge_api_grants WHERE station_id_snapshot LIKE 'station_fga_%'`;
};

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "fga-owner@example.com", name: "FO" });
  tenant = BOOTSTRAP_TENANT_ID;
  await clean();
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'fga-box', 'fb', 'linux', 'amd64', 2, 'online', 'x', now())`;
  for (const s of [ST_A, ST_B, ST_DEL, ST_DEL2, ST_GEN]) await addStation(s);
});

afterAll(async () => {
  await clean();
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
});

describe("live grant uniqueness", () => {
  test("rejects a second live grant for the same station/provider/instance", async () => {
    await grant();
    expect(await violated(grant())).toBe(LIVE_IDX);
    const [{ n }] = (await rawSql`SELECT count(*)::int n FROM station_forge_api_grants WHERE station_id_snapshot = ${ST_A}`) as any[];
    expect(n).toBe(1);
  });

  test("allows a new grant after the previous is revoked", async () => {
    const [first] = (await rawSql`SELECT id FROM station_forge_api_grants WHERE station_id_snapshot = ${ST_A}`) as any[];
    await setState(first.id, "revoked");
    await expect(grant({ generation: 2 })).resolves.toBeString();
  });

  test("two different instances of the same provider on one station are allowed", async () => {
    await grant({ instance: "https://other.example.test" });
  });

  test("two different stations may each hold a live grant for the same provider+instance", async () => {
    await grant({ stationId: ST_B, stationIdSnapshot: ST_B });
  });

  test("a failed or revoking grant still occupies the slot (only revoked frees it)", async () => {
    const id = await grant({ stationId: ST_B, stationIdSnapshot: ST_B, instance: "https://third.example.test" });
    for (const s of ["failed", "revoking"]) {
      await setState(id, s);
      expect(
        await violated(grant({ stationId: ST_B, stationIdSnapshot: ST_B, instance: "https://third.example.test" })),
      ).toBe(LIVE_IDX);
    }
  });
});

describe("station deletion", () => {
  test("deleting a station nulls stationId and keeps the row, its snapshot and its live state", async () => {
    const id = await grant({ stationId: ST_DEL, stationIdSnapshot: ST_DEL, state: "verified" });
    await rawSql`DELETE FROM stations WHERE id = ${ST_DEL}`;
    const [row] = (await rawSql`SELECT station_id, station_id_snapshot, state FROM station_forge_api_grants WHERE id = ${id}`) as any[];
    expect(row).toEqual({ station_id: null, station_id_snapshot: ST_DEL, state: "verified" });
  });

  test("a live orphaned grant still blocks a duplicate by snapshot", async () => {
    expect(await violated(grant({ stationId: null, stationIdSnapshot: ST_DEL, state: "authorised", generation: 2 }))).toBe(LIVE_IDX);
  });

  test("a revoked tombstone survives station deletion", async () => {
    const id = await grant({ stationId: ST_DEL2, stationIdSnapshot: ST_DEL2, state: "revoked", revokedAt: new Date() });
    await rawSql`DELETE FROM stations WHERE id = ${ST_DEL2}`;
    const [row] = (await rawSql`SELECT station_id, station_id_snapshot, state FROM station_forge_api_grants WHERE id = ${id}`) as any[];
    expect(row).toEqual({ station_id: null, station_id_snapshot: ST_DEL2, state: "revoked" });
  });
});

describe("tenant scope", () => {
  test("tenant scope lists the table", () => {
    expect(Object.values(TENANT_SCOPED_TABLES).map((t) => getTableName(t))).toContain("station_forge_api_grants");
    expect(Object.values(TENANT_SCOPED_TABLES)).toContain(stationForgeApiGrants);
  });
});

describe("generation", () => {
  const next = () => nextGeneration(db, tenant, ST_GEN, "forgejo", FORGE);

  test("starts at 1 when nothing exists", async () => {
    expect(await next()).toBe(1);
  });

  test("generation continues across re-grants (counts tombstones, survives station deletion)", async () => {
    const g1 = await grant({ stationId: ST_GEN, stationIdSnapshot: ST_GEN, generation: await next() });
    expect(await next()).toBe(2);
    await setState(g1, "revoked");
    const g2 = await grant({ stationId: ST_GEN, stationIdSnapshot: ST_GEN, generation: await next() });
    expect(await next()).toBe(3);
    await setState(g2, "revoked");
    await rawSql`DELETE FROM stations WHERE id = ${ST_GEN}`;
    expect(await next()).toBe(3);
  });

  test("is keyed per provider and instance, and per tenant", async () => {
    expect(await nextGeneration(db, tenant, ST_GEN, "forgejo", "https://elsewhere.test")).toBe(1);
    expect(await nextGeneration(db, tenant, ST_GEN, "github", FORGE)).toBe(1);
    expect(await nextGeneration(db, "fleet_someone_else", ST_GEN, "forgejo", FORGE)).toBe(1);
  });

  test("works inside a transaction", async () => {
    const n = await db.transaction((tx) => nextGeneration(tx, tenant, ST_GEN, "forgejo", FORGE));
    expect(n).toBe(3);
  });
});

describe("generation uniqueness under concurrency", () => {
  const GEN_IDX = "station_forge_api_grants_generation_idx";
  const base = { stationId: null, stationIdSnapshot: "station_fga_race", instance: FORGE };

  test("a plain duplicate generation insert is rejected", async () => {
    await grant({ ...base, generation: 7, state: "revoked", revokedAt: new Date() });
    expect(await violated(grant({ ...base, generation: 7 }))).toBe(GEN_IDX);
  });

  test("two racing transactions get distinct generations (tombstone vs live)", async () => {
    const take = (state: string) =>
      db.transaction(async (tx) => {
        const generation = await nextGeneration(tx, tenant, "station_fga_race", "forgejo", FORGE);
        await tx.insert(stationForgeApiGrants).values({
          id: `fga_race_${state}_${seq++}`,
          tenantId: tenant,
          ...base,
          provider: "forgejo",
          mode: "minted",
          account: "agent-x",
          repositories: [],
          preset: "read",
          state: state as never,
          revokedAt: state === "revoked" ? new Date() : null,
          generation,
          createdBy: OWNER,
        });
        return generation;
      });
    const [a, b] = await Promise.all([take("revoked"), take("authorised")]);
    expect(a).not.toBe(b);
    expect(Math.min(a, b)).toBe(8);
    expect(Math.max(a, b)).toBe(9);
  });

  test("nextGeneration under the lock still returns max+1", async () => {
    expect(await db.transaction((tx) => nextGeneration(tx, tenant, "station_fga_race", "forgejo", FORGE))).toBe(10);
  });
});

describe("integrity CHECKs and FKs", () => {
  const at = (n: string) => ({ stationId: ST_B, stationIdSnapshot: ST_B, instance: `https://int-${n}.test` });

  test("state=revoked requires revoked_at, and revoked_at requires state=revoked", async () => {
    expect(await violated(grant({ ...at("r1"), state: "revoked", revokedAt: null }))).toBe("station_forge_api_grants_revoked_at_check");
    expect(await violated(grant({ ...at("r2"), state: "verified", revokedAt: new Date() }))).toBe("station_forge_api_grants_revoked_at_check");
  });

  test("sealed_blob and sealed_expires_at are both set or both null", async () => {
    expect(await violated(grant({ ...at("s1"), sealedBlob: "stk-handover-v1:x" }))).toBe("station_forge_api_grants_sealed_check");
    expect(await violated(grant({ ...at("s2"), sealedExpiresAt: new Date() }))).toBe("station_forge_api_grants_sealed_check");
    await grant({ ...at("s3"), sealedBlob: "stk-handover-v1:x", sealedExpiresAt: new Date() });
  });

  test("generation must be >= 1", async () => {
    expect(await violated(grant({ ...at("g0"), generation: 0 }))).toBe("station_forge_api_grants_generation_check");
  });

  test("the tenant FK (restrict) refuses deleting a tenant that has a grant", async () => {
    const T = "fleet_fga_tenant_restrict";
    await rawSql`DELETE FROM station_forge_api_grants WHERE tenant_id = ${T}`;
    await rawSql`DELETE FROM tenants WHERE id = ${T}`;
    await rawSql`INSERT INTO tenants (id, name) VALUES (${T}, 'fga restrict')`;
    await grant({ tenantId: T, stationId: null, stationIdSnapshot: "station_fga_tenant", instance: FORGE });
    let err: any;
    try {
      await rawSql`DELETE FROM tenants WHERE id = ${T}`;
    } catch (e) {
      err = e;
    }
    expect(err?.constraint_name ?? err?.constraint).toBe("station_forge_api_grants_tenant_id_tenants_id_fk");
    await rawSql`DELETE FROM station_forge_api_grants WHERE tenant_id = ${T}`;
    await rawSql`DELETE FROM tenants WHERE id = ${T}`;
  });
});

describe("CHECK constraints", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["state", { state: "bogus" }],
    ["mode", { mode: "bogus" }],
    ["provider", { provider: "gitlab" }],
    ["preset", { preset: "admin" }],
    ["isolation", { isolation: "shared" }],
  ];
  for (const [col, over] of cases) {
    test(`rejects a bad ${col}`, async () => {
      expect(
        await violated(grant({ stationId: ST_B, stationIdSnapshot: ST_B, instance: `https://chk-${col}.test`, ...over })),
      ).toBe(`station_forge_api_grants_${col}_check`);
    });
  }

  test("accepts every documented state", async () => {
    let i = 0;
    for (const state of ["authorised", "provisioned", "delivered", "verified", "failed", "revoking", "revoked"]) {
      await grant({
        stationId: ST_B,
        stationIdSnapshot: ST_B,
        instance: `https://ok-${i++}.test`,
        state,
        revokedAt: state === "revoked" ? new Date() : null,
      });
    }
    await grant({ stationId: ST_B, stationIdSnapshot: ST_B, instance: "https://ok-iso.test", isolation: "same-user" });
  });
});

describe("policy outstanding", () => {
  test("policy_pending_since is a nullable timestamptz, independent of state_reason", async () => {
    const [col] = await rawSql`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'station_forge_api_grants' AND column_name = 'policy_pending_since'`;
    expect(col).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES" });
  });
});

describe("same-user acknowledgement", () => {
  test("same_user_ack_at (timestamptz) and same_user_ack_by (text) are nullable", async () => {
    const cols = await rawSql`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'station_forge_api_grants' AND column_name IN ('same_user_ack_at','same_user_ack_by')
      ORDER BY column_name`;
    expect(cols.map((c) => ({ ...c }))).toEqual([
      { column_name: "same_user_ack_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "same_user_ack_by", data_type: "text", is_nullable: "YES" },
    ]);
  });
});
