/**
 * Integration Test: the tenant boundary, as it exists in Postgres.
 *
 * `tests/unit/tenant-scope.test.ts` pins the boundary's shape in TypeScript.
 * This file exists because a column declared in a Drizzle schema and never
 * migrated would pass every assertion there and isolate nothing — the same
 * reason `acp-runs-id-space.test.ts` exercises its CHECKs against a real
 * database rather than against drizzle's in-memory table config.
 *
 * Two halves:
 *
 * 1. **The database agrees with the whitelist.** Read from `information_schema`,
 *    in both directions — every registered table really has the column, and
 *    every table that has the column is really registered. The second direction
 *    is the one that catches drift: a migration that adds `tenant_id` to a new
 *    table fails here until someone decides what that table is.
 *
 * 2. **A scoped read really is scoped.** Two tenants, one user id, one query.
 *    With one tenant in production this is the only place the isolation can
 *    actually be observed, so it is the only place that can prove the predicate
 *    does something — which makes it the test that fails if the scoping is
 *    removed from `listNodes`.
 *
 * DATABASE_URL must point to the local Docker test-postgres on localhost:5434.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { getTableName } from "drizzle-orm";

import { rawSql } from "../../src/db/drizzle";
import { BOOTSTRAP_TENANT_ID, TENANT_SCOPED_TABLES } from "../../src/db/tenant-scope";
import { listNodes } from "../../src/services/node-registry";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const OTHER_TENANT = "fleet_11111111111111111111";
const SHARED_USER = "tenant-isolation-user";
const OWN_NODE = "node_1111111111111111aaaa";
const FOREIGN_NODE = "node_2222222222222222bbbb";

const scopedNames = Object.values(TENANT_SCOPED_TABLES).map((t) => getTableName(t)).sort();

beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`DELETE FROM nodes WHERE id IN (${OWN_NODE}, ${FOREIGN_NODE})`;
  await rawSql`DELETE FROM tenants WHERE id = ${OTHER_TENANT}`;
  await rawSql`DELETE FROM "user" WHERE id = ${SHARED_USER}`;
  await rawSql`INSERT INTO "user" (id, name, email, email_verified)
               VALUES (${SHARED_USER}, 'Shared', 'shared@tenant-isolation.test', true)`;
  await rawSql`INSERT INTO tenants (id, name) VALUES (${OTHER_TENANT}, 'Other')`;

  // The same user id, the same everything — except the tenant. This is the row
  // that must not come back, and the ONLY thing that can keep it out is the
  // tenant predicate: an owner filter matches it perfectly.
  for (const [id, tenant] of [
    [OWN_NODE, BOOTSTRAP_TENANT_ID],
    [FOREIGN_NODE, OTHER_TENANT],
  ] as const) {
    await rawSql`
      INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, secret_hash)
      VALUES (${id}, ${tenant}, ${SHARED_USER}, ${id}, 'h', 'linux', 'arm64', 'x')`;
  }
});

afterAll(async () => {
  await rawSql`DELETE FROM nodes WHERE id IN (${OWN_NODE}, ${FOREIGN_NODE})`;
  await rawSql`DELETE FROM tenants WHERE id = ${OTHER_TENANT}`;
  await rawSql`DELETE FROM "user" WHERE id = ${SHARED_USER}`;
});

describe("the boundary reached the database", () => {
  test("the bootstrap tenant exists with the deterministic id", async () => {
    const rows = await rawSql`SELECT id FROM tenants WHERE id = ${BOOTSTRAP_TENANT_ID}`;
    expect(rows.map((r) => r.id)).toEqual([BOOTSTRAP_TENANT_ID]);
  });

  test("every registered table really has a NOT NULL tenant_id", async () => {
    const rows = await rawSql<{ table_name: string; is_nullable: string }[]>`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'`;
    const byName = new Map(rows.map((r) => [r.table_name, r.is_nullable]));

    const missing = scopedNames.filter((t) => !byName.has(t));
    expect(missing).toEqual([]);

    const nullable = scopedNames.filter((t) => byName.get(t) !== "NO");
    expect(nullable).toEqual([]);
  });

  test("every table with a tenant_id is registered as tenant-scoped", async () => {
    // The direction that catches drift. A migration adding `tenant_id` to a
    // table nobody classified leaves a column the database enforces and no
    // query uses — scoped in storage, unscoped in every read.
    const rows = await rawSql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name <> 'tenants'`;
    const unregistered = rows.map((r) => r.table_name).filter((t) => !scopedNames.includes(t)).sort();
    expect(unregistered).toEqual([]);
  });

  test("every scoped table's tenant_id is a foreign key to tenants", async () => {
    // NOT NULL alone would let a row name a tenant that does not exist.
    const rows = await rawSql<{ table_name: string }[]>`
      SELECT DISTINCT tc.table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        AND kcu.column_name = 'tenant_id' AND ccu.table_name = 'tenants'`;
    const withFk = rows.map((r) => r.table_name);
    expect(scopedNames.filter((t) => !withFk.includes(t))).toEqual([]);
  });

  test("no row anywhere sits outside a tenant that exists", async () => {
    // The backfill's standing assertion, re-checked against whatever the suite
    // has since written rather than only against the migration's own output.
    for (const t of scopedNames) {
      const [{ orphans }] = (await rawSql.unsafe(
        `SELECT count(*)::text AS orphans FROM "${t}" s
         WHERE NOT EXISTS (SELECT 1 FROM tenants x WHERE x.id = s.tenant_id)`,
      )) as unknown as { orphans: string }[];
      expect({ table: t, orphans }).toEqual({ table: t, orphans: "0" });
    }
  });
});

describe("a scoped read is scoped by tenant, not only by owner", () => {
  test("listNodes returns the caller's tenant and not another's", async () => {
    // THE MUTATION TARGET. Both nodes have the same user_id, so the owner
    // predicate matches both; only the tenant predicate separates them. Delete
    // the tenantScope() call from listNodes and this test fails — which is the
    // whole claim that the scoping does something.
    const ids = (await listNodes(SHARED_USER)).map((n) => n.id).sort();
    expect(ids).toEqual([OWN_NODE]);
  });

  test("the foreign node really is there to be leaked", async () => {
    // Guard the guard. If the fixture silently stopped inserting the other
    // tenant's row, the test above would pass while proving nothing at all.
    const rows = await rawSql`
      SELECT id FROM nodes WHERE user_id = ${SHARED_USER} AND tenant_id = ${OTHER_TENANT}`;
    expect(rows.map((r) => r.id)).toEqual([FOREIGN_NODE]);
  });

  test("both rows share an owner, so the owner filter cannot be what excluded one", async () => {
    const rows = await rawSql`SELECT id FROM nodes WHERE user_id = ${SHARED_USER} ORDER BY id`;
    expect(rows.map((r) => r.id)).toEqual([OWN_NODE, FOREIGN_NODE].sort());
  });
});
