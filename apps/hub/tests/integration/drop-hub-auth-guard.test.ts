/**
 * The drop migration's guard (security review finding 1): it must refuse to drop the hub's auth
 * tables on a database the user-id rewrite never ran on, and drop nothing when it refuses.
 *
 * Against a SCRATCH database this file creates and drops: the guard looks at every product
 * table, and the shared test database holds other files' rows. Migrated first to just before the
 * drop (a copy of the migrations folder whose journal stops there), seeded, then migrated with the
 * real folder.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.DATABASE_URL ?? "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
const FOLDER = join(import.meta.dir, "..", "..", "src", "db", "drizzle-migrations");
const DROP_TAG = "0096_drop_hub_auth";
const quiet = { onnotice: () => {} };
const admin = postgres(BASE.replace(/\/[^/]+$/, "/postgres"), { max: 1, ...quiet });

const T = "fleet_00000000000000000000";
const BA_USER = "11111111-1111-4111-8111-111111111111"; // a Better Auth id
const PRN = "prn_1111111111111111aaaa";

/** The migrations folder as it stood just before the drop. */
function folderBeforeDrop(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentpod-before-drop-"));
  cpSync(FOLDER, dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === DROP_TAG);
  expect(at).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function scratchBeforeDrop() {
  const name = `agentpod_drop_guard_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const sql = postgres(BASE.replace(/\/[^/]+$/, `/${name}`), { max: 1, ...quiet });
  const before = folderBeforeDrop();
  cleanups.push(async () => {
    await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    rmSync(before, { recursive: true, force: true });
  });
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await migrate(drizzle(sql), { migrationsFolder: before });
  const tables = async () =>
    (await sql<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('user', 'principals', 'principal_identities', 'session')`).map((r) => r.t).sort();
  const migrateDrop = () => migrate(drizzle(sql), { migrationsFolder: FOLDER });
  return { sql, tables, migrateDrop };
}

describe("the drop migration's guard", () => {
  test("the reviewer's probe: a Better Auth id still in a product column — the migration raises and nothing is dropped", async () => {
    const { sql, tables, migrateDrop } = await scratchBeforeDrop();
    await sql`INSERT INTO "user" (id, name, email, role) VALUES (${BA_USER}, 'One', 'one@example.com', 'admin')`;
    await sql`INSERT INTO principals (id, kind, org_id, handle) VALUES (${PRN}, 'human', 'org_00000000000000000000', 'one')`;
    await sql`INSERT INTO principal_identities (id, principal_id, system, external_id) VALUES ('pid_1', ${PRN}, 'better-auth', ${BA_USER})`;
    await sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('k1', 'v', ${BA_USER})`;
    const before = await tables();
    expect(before).toEqual(["principal_identities", "principals", "session", "user"]);

    const err = await migrateDrop().catch((e) => e);
    expect(String(err?.cause?.message ?? err?.message ?? err)).toContain("system_settings.updated_by still holds 1 non-prn_ value");
    expect(await tables()).toEqual(before);
    expect((await sql`SELECT updated_by FROM system_settings`)[0]!.updated_by).toBe(BA_USER);
  }, 120_000);

  test("every column prn_ but legacy_user_principals empty while Better Auth identities exist — raises", async () => {
    const { sql, tables, migrateDrop } = await scratchBeforeDrop();
    await sql`INSERT INTO principals (id, kind, org_id, handle) VALUES (${PRN}, 'human', 'org_00000000000000000000', 'one')`;
    await sql`INSERT INTO principal_identities (id, principal_id, system, external_id) VALUES ('pid_1', ${PRN}, 'better-auth', ${BA_USER})`;
    await sql`ALTER TABLE system_settings DROP CONSTRAINT system_settings_updated_by_user_id_fk`; // as the rewrite does
    await sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('k1', 'v', ${PRN})`;
    const err = await migrateDrop().catch((e) => e);
    expect(String(err?.cause?.message ?? err?.message ?? err)).toContain("legacy_user_principals is empty");
    expect(await tables()).toEqual(["principal_identities", "principals", "session", "user"]);
  }, 120_000);

  test("after the rewrite (prn_ everywhere, the map seeded) the drop runs", async () => {
    const { sql, tables, migrateDrop } = await scratchBeforeDrop();
    await sql`INSERT INTO principals (id, kind, org_id, handle) VALUES (${PRN}, 'human', 'org_00000000000000000000', 'one')`;
    await sql`INSERT INTO principal_identities (id, principal_id, system, external_id) VALUES ('pid_1', ${PRN}, 'better-auth', ${BA_USER})`;
    await sql`INSERT INTO legacy_user_principals (user_id, principal_id) VALUES (${BA_USER}, ${PRN})`;
    await sql`ALTER TABLE system_settings DROP CONSTRAINT system_settings_updated_by_user_id_fk`; // as the rewrite does
    await sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('k1', 'v', ${PRN})`;
    await sql`INSERT INTO station_audit (id, tenant_id, user_id, node_id, station_key, verb) VALUES ('a1', ${T}, ${PRN}, 'node_x', 's', 'v')`;
    await migrateDrop();
    expect(await tables()).toEqual([]);
  }, 120_000);

  test("an empty database (a fresh install) passes", async () => {
    const { tables, migrateDrop } = await scratchBeforeDrop();
    await migrateDrop();
    expect(await tables()).toEqual([]);
  }, 120_000);
});
afterAll(async () => {
  await admin.end();
});
