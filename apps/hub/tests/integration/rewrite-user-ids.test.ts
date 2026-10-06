/**
 * The user.id → prn_ rewrite (scripts/rewrite-user-ids.ts), against a SCRATCH database that this
 * file creates and drops (as migration-race.test.ts does): --apply drops foreign keys, and doing
 * that to the shared test database would break the ~81 test files that clean up through
 * ON DELETE CASCADE.
 *
 * The tests run in file order against one scratch database; each describe leaves it in the state
 * the next one starts from.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyRewrite,
  NOT_REWRITTEN,
  OWNER_FKS,
  planRewrite,
  RewriteRefused,
  USER_ID_COLUMNS,
} from "../../scripts/rewrite-user-ids";

const BASE = process.env.DATABASE_URL ?? "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
const SCRATCH = `agentpod_rewrite_scratch_${Date.now()}`;
const SCRATCH_URL = BASE.replace(/\/[^/]+$/, `/${SCRATCH}`);
const quiet = { onnotice: () => {} };
const admin = postgres(BASE.replace(/\/[^/]+$/, "/postgres"), { max: 1, ...quiet });
let sql: ReturnType<typeof postgres>;

const T = "fleet_00000000000000000000";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222"; // an admin
const P1 = "prn_1111111111111111aaaa";
const P2 = "prn_2222222222222222bbbb";
const P3 = "prn_3333333333333333cccc"; // a human who first signed in at the plane: no Better Auth id
const ORPHAN = "default-user";
const HEX64 = "a".repeat(64);
const USER_FKS = USER_ID_COLUMNS.filter((c) => c.fk).map((c) => c.fk!);

/** Every row of every rewritten table, as JSON text: "identical data" means this is equal. */
async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of new Set(USER_ID_COLUMNS.map((c) => c.table))) {
    const rows = await sql.unsafe<{ j: string }[]>(`SELECT to_jsonb(t)::text AS j FROM "${table}" t ORDER BY 1`);
    out[table] = rows.map((r) => r.j);
  }
  return out;
}

async function constraintDefs(names: readonly string[]): Promise<Record<string, string>> {
  const rows = await sql<{ conname: string; def: string }[]>`
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ANY(${names as string[]})`;
  return Object.fromEntries(rows.map((r) => [r.conname, r.def]));
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${SCRATCH}`);
  sql = postgres(SCRATCH_URL, { max: 2, ...quiet });
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await migrate(drizzle(sql), { migrationsFolder: join(import.meta.dir, "..", "..", "src", "db", "drizzle-migrations") });

  await sql`INSERT INTO "user" (id, name, email, role) VALUES (${U1}, 'One', 'one@example.com', 'user'), (${U2}, 'Two', 'two@example.com', 'admin')`;
  await sql`INSERT INTO principals (id, kind, org_id, handle) VALUES (${P1}, 'human', 'org_00000000000000000000', 'one'), (${P2}, 'human', 'org_00000000000000000000', 'two'), (${P3}, 'human', 'org_00000000000000000000', 'three')`;
  await sql`INSERT INTO principal_identities (id, principal_id, system, external_id) VALUES ('pid_1', ${P1}, 'better-auth', ${U1}), ('pid_2', ${P2}, 'better-auth', ${U2})`;
  await sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('k1', 'v', ${U1}), ('k2', 'v', ${U2})`;
  await sql`INSERT INTO station_audit (id, tenant_id, user_id, node_id, station_key, verb) VALUES
    ('a1', ${T}, ${U1}, 'node_x', 's', 'v'),
    ('a2', ${T}, ${U1}, 'node_x', 's', 'v')`;

  // A row in every other rewritten column, owned by U1 — including the tables tied together by
  // the six composite owner FKs, which only block an in-place rewrite when they have rows.
  await sql`INSERT INTO nodes (id, user_id, name, hostname, os, arch, secret_hash, tenant_id) VALUES ('node_1', ${U1}, 'n', 'h', 'linux', 'arm64', 'x', ${T})`;
  await sql`INSERT INTO stations (id, user_id, node_id, harness, station_key, kind, display_name, tenant_id) VALUES ('stn_1', ${U1}, 'node_1', 'hermes', 'k', 'adopted', 'S', ${T})`;
  await sql`INSERT INTO station_setups (request_id, station_id, tenant_id, user_id, input, principal_id) VALUES ('req_1', 'stn_1', ${T}, ${U1}, '{}', ${P1})`;
  await sql`INSERT INTO skill_artifacts (id, tenant_id, user_id, archive_sha256, harness, profile, size, bytes) VALUES ('art_1', ${T}, ${U1}, ${HEX64}, 'hermes', 'p', 1, '\\x00'::bytea)`;
  await sql`INSERT INTO skill_operations (id, tenant_id, user_id, station_id, node_id, station_key, harness, profile, action, artifact_id) VALUES (${"b".repeat(32)}, ${T}, ${U1}, 'stn_1', 'node_1', 'k', 'hermes', 'p', 'install', 'art_1')`;
  await sql`INSERT INTO trusted_skill_releases (id, tenant_id, user_id, version, profile, record_digest, record) VALUES ('rel_1', ${T}, ${U1}, '1', 'p', ${HEX64}, '{}')`;
  await sql`INSERT INTO trusted_skill_release_artifacts (release_id, tenant_id, user_id, artifact_id, harness, bundle_digest) VALUES ('rel_1', ${T}, ${U1}, 'art_1', 'hermes', ${HEX64})`;
  await sql`INSERT INTO skill_release_cohorts (id, tenant_id, user_id, release_id, record_digest, station_ids) VALUES ('coh_1', ${T}, ${U1}, 'rel_1', ${HEX64}, '["stn_1"]')`;
  await sql`INSERT INTO acp_sessions (id, station_id, user_id, mode, status, created_at, last_event_at, tenant_id) VALUES ('acp_1', 'stn_1', ${U1}, 'interactive', 'open', now(), now(), ${T})`;
  await sql`INSERT INTO admin_audit_log (id, admin_user_id, target_user_id, action) VALUES ('aal_1', ${U2}, ${U1}, 'x')`;
  await sql`INSERT INTO agent_tasks (id, user_id, sandbox_id, message, tenant_id) VALUES ('at_1', ${U1}, 'sb', 'm', ${T})`;
  await sql`INSERT INTO bridge_agents (tenant_id, key, board_id, station_id, token_encrypted, created_by) VALUES (${T}, 'b', 'brd_0123456789abcdef', 'stn_1', 't', ${U1})`;
  await sql`INSERT INTO cloudflare_sandboxes (id, user_id, worker_url, tenant_id) VALUES ('cfs_1', ${U1}, 'https://w', ${T})`;
  await sql`INSERT INTO enrollment_tokens (id, user_id, token_hash, expires_at, tenant_id) VALUES ('et_1', ${U1}, 'h', now(), ${T})`;
  await sql`INSERT INTO matrix_missions (id, tenant_id, user_id, name, alias) VALUES ('mm_1', ${T}, ${U1}, 'n', 'a')`;
  await sql`INSERT INTO provisioned_runtimes (id, user_id, provider, name, tenant_id) VALUES ('pr_1', ${U1}, 'modal', 'n', ${T})`;
  await sql`INSERT INTO station_speech (station_id, tenant_id, updated_by) VALUES ('stn_1', ${T}, ${U1})`;
  await sql`INSERT INTO station_transcription (station_id, tenant_id, updated_by) VALUES ('stn_1', ${T}, ${U1})`;
  await sql`INSERT INTO declared_harness_config (id, tenant_id, setting_id, value, declared_by) VALUES ('dhc_1', ${T}, 's', '{}', ${U1})`;
  await sql`INSERT INTO harness_config_opt_out (id, tenant_id, setting_id, opted_out_by, node_id) VALUES ('hco_1', ${T}, 's', ${U1}, 'node_1')`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.end();
});

describe("the inventory is the schema, not a memory", () => {
  test("every FK to user.id is either rewritten or named as not rewritten", async () => {
    const live = await sql<{ col: string }[]>`
      SELECT c.conrelid::regclass::text || '.' || a.attname AS col
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'public."user"'::regclass`;
    const expected = [
      ...USER_ID_COLUMNS.filter((c) => c.fk).map((c) => `${c.table}.${c.column}`),
      "account.user_id", "session.user_id", "device_credentials.user_id",
    ].sort();
    expect(live.map((r) => r.col).sort()).toEqual(expected); // 21 today: 18 rewritten + 3 auth
  });

  test("every column named like a user reference is either rewritten or named as not rewritten", async () => {
    const live = await sql<{ col: string }[]>`
      SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE table_schema = 'public' AND (column_name ~ '(^|_)user_id$' OR column_name ~ '_by$')`;
    const known = new Set([...USER_ID_COLUMNS.map((c) => `${c.table}.${c.column}`), ...NOT_REWRITTEN]);
    expect(live.map((r) => r.col).filter((c) => !known.has(c)).sort()).toEqual([]);
  });

  test("every owner FK the script drops exists", async () => {
    const rows = await sql<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE conname = ANY(${OWNER_FKS as string[]})`;
    expect(rows.map((r) => r.conname).sort()).toEqual([...OWNER_FKS].sort());
  });

  test("23 columns", () => expect(USER_ID_COLUMNS).toHaveLength(23));
});

describe("dry run", () => {
  test("counts per column and names what it cannot map", async () => {
    await sql`INSERT INTO station_audit (id, tenant_id, user_id, node_id, station_key, verb) VALUES ('a3', ${T}, ${ORPHAN}, 'node_x', 's', 'v')`;
    const before = await snapshot();
    const plan = await planRewrite(sql, { direction: "forward" });
    expect(plan.counts.find((c) => c.table === "station_audit")).toEqual({ table: "station_audit", column: "user_id", rows: 3, toRewrite: 2, alreadyTarget: 0, unmapped: 1 });
    expect(plan.counts.every((c) => c.rows >= 1)).toBe(true); // the fixture reaches every column
    expect(plan.unmapped).toEqual([{ table: "station_audit", column: "user_id", value: ORPHAN, rows: 1 }]);
    expect(plan.collisions).toEqual([]);
    expect(plan.operators).toEqual([P2]);
    expect(plan.tenantMapping).toBe("ok");
    // a dry run changes nothing
    expect((await sql`SELECT user_id FROM station_audit WHERE id = 'a1'`)[0]!.user_id).toBe(U1);
    expect(await snapshot()).toEqual(before);
  });

  test("refuses to apply while any value is unmapped, and changes nothing", async () => {
    const before = await snapshot();
    const err = await applyRewrite(sql, { direction: "forward" }).catch((e) => e);
    expect(err).toBeInstanceOf(RewriteRefused);
    expect((err as RewriteRefused).plan.unmapped).toEqual([{ table: "station_audit", column: "user_id", value: ORPHAN, rows: 1 }]);
    expect((await sql`SELECT updated_by FROM system_settings WHERE key = 'k1'`)[0]!.updated_by).toBe(U1);
    const fks = await sql`SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_updated_by_user_id_fk'`;
    expect(fks).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
    expect(await sql`SELECT 1 FROM legacy_user_principals`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM hub_operators`).toHaveLength(0);
  });

  test("--map names the value's principal, and the plan then has nothing unmapped", async () => {
    const plan = await planRewrite(sql, { direction: "forward", extra: { [ORPHAN]: P2 } });
    expect(plan.unmapped).toEqual([]);
    expect(plan.counts.find((c) => c.table === "station_audit")!.toRewrite).toBe(3);
  });

  test("an admin with no principal is unmapped: the apply would silently drop an operator", async () => {
    await sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-lost-admin', 'Lost', 'lost@example.com', 'admin')`;
    try {
      const plan = await planRewrite(sql, { direction: "forward", extra: { [ORPHAN]: P2 } });
      expect(plan.unmapped).toEqual([{ table: "user", column: "id (role = admin)", value: "u-lost-admin", rows: 1 }]);
      const mapped = await planRewrite(sql, { direction: "forward", extra: { [ORPHAN]: P2, "u-lost-admin": P3 } });
      expect(mapped.unmapped).toEqual([]);
      expect(mapped.operators).toEqual([P2, P3]);
    } finally {
      await sql`DELETE FROM "user" WHERE id = 'u-lost-admin'`;
    }
  });
});

describe("refusals before anything changes", () => {
  const opts = { direction: "forward" as const, extra: { [ORPHAN]: P2 } };

  async function expectRefusedUnchanged(reason: RegExp): Promise<RewriteRefused> {
    const before = await snapshot();
    const err = await applyRewrite(sql, opts).catch((e) => e);
    expect(err).toBeInstanceOf(RewriteRefused);
    expect(String(err.message)).toMatch(reason);
    expect(await snapshot()).toEqual(before);
    expect(Object.keys(await constraintDefs(USER_FKS))).toHaveLength(USER_FKS.length);
    return err as RewriteRefused;
  }

  test("the bootstrap tenant has no org-plane mapping", async () => {
    await sql`UPDATE tenants SET external_source = NULL, external_id = NULL WHERE id = ${T}`;
    try {
      expect((await planRewrite(sql, opts)).tenantMapping).toBe("missing");
      await expectRefusedUnchanged(/bootstrap tenant mapping is missing/);
    } finally {
      await sql`UPDATE tenants SET external_source = 'org-plane', external_id = 'org_00000000000000000000' WHERE id = ${T}`;
    }
  });

  test("the bootstrap tenant maps to another org", async () => {
    await sql`UPDATE tenants SET external_id = 'org_99999999999999999999' WHERE id = ${T}`;
    try {
      expect((await planRewrite(sql, opts)).tenantMapping).toBe("conflict");
      await expectRefusedUnchanged(/bootstrap tenant mapping is conflict/);
      // --org names the org the plane actually keeps, and then it matches
      expect((await planRewrite(sql, { ...opts, org: "org_99999999999999999999" })).tenantMapping).toBe("ok");
    } finally {
      await sql`UPDATE tenants SET external_id = 'org_00000000000000000000' WHERE id = ${T}`;
    }
  });

  test("the bootstrap tenant maps to the org from another source", async () => {
    await sql`UPDATE tenants SET external_source = 'workos' WHERE id = ${T}`;
    try {
      expect((await planRewrite(sql, opts)).tenantMapping).toBe("conflict");
      await expectRefusedUnchanged(/bootstrap tenant mapping is conflict/);
    } finally {
      await sql`UPDATE tenants SET external_source = 'org-plane' WHERE id = ${T}`;
    }
  });

  test("a principal with two Better Auth ids (the reverse could not choose) is a collision", async () => {
    // The schema's unique (principal_id, system) index forbids this; the script checks anyway.
    await sql`DROP INDEX principal_identities_principal_system_idx`;
    await sql`INSERT INTO principal_identities (id, principal_id, system, external_id) VALUES ('pid_dup', ${P1}, 'better-auth', 'u-dup')`;
    try {
      const plan = await planRewrite(sql, opts);
      expect(plan.collisions).toEqual([{ principalId: P1, userIds: [U1, "u-dup"].sort() }]);
      await expectRefusedUnchanged(/more than one Better Auth identity/);
    } finally {
      await sql`DELETE FROM principal_identities WHERE id = 'pid_dup'`;
      await sql`CREATE UNIQUE INDEX principal_identities_principal_system_idx ON principal_identities (principal_id, system)`;
    }
  });

  test("a failure part-way through rolls the whole rewrite back (one transaction)", async () => {
    // The last column in the inventory fails to update; everything before it must roll back.
    await sql.unsafe(`
      CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
      CREATE TRIGGER boom BEFORE UPDATE ON harness_config_opt_out FOR EACH ROW EXECUTE FUNCTION boom();`);
    try {
      const before = await snapshot();
      const owners = await constraintDefs(OWNER_FKS);
      const err = await applyRewrite(sql, opts).catch((e) => e);
      expect(String(err?.message)).toContain("boom");
      expect(await snapshot()).toEqual(before);
      expect(Object.keys(await constraintDefs(USER_FKS))).toHaveLength(USER_FKS.length);
      expect(await constraintDefs(OWNER_FKS)).toEqual(owners);
      expect(await sql`SELECT 1 FROM legacy_user_principals`).toHaveLength(0);
    } finally {
      await sql.unsafe(`DROP TRIGGER boom ON harness_config_opt_out; DROP FUNCTION boom();`);
    }
  });
});

describe("apply, then reverse", () => {
  let ownerDefs: Record<string, string>;

  test("forward rewrites every value, drops user FKs, keeps owner FKs, seeds the map and operators", async () => {
    ownerDefs = await constraintDefs(OWNER_FKS);
    const plan = await applyRewrite(sql, { direction: "forward", extra: { [ORPHAN]: P2 } });
    expect(plan.unmapped).toEqual([]);
    expect((await sql`SELECT user_id FROM station_audit ORDER BY id`).map((r) => r.user_id)).toEqual([P1, P1, P2]);
    expect((await sql`SELECT updated_by FROM system_settings ORDER BY key`).map((r) => r.updated_by)).toEqual([P1, P2]);
    expect(await sql`SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_updated_by_user_id_fk'`).toHaveLength(0);
    expect(await constraintDefs(USER_FKS)).toEqual({});
    expect(await constraintDefs(OWNER_FKS)).toEqual(ownerDefs);
    expect((await sql`SELECT principal_id FROM hub_operators`).map((r) => r.principal_id)).toEqual([P2]);
    expect((await sql`SELECT user_id, principal_id FROM legacy_user_principals ORDER BY user_id`).map((r) => [r.user_id, r.principal_id])).toEqual([[U1, P1], [U2, P2]]);
    // every rewritten column now holds only prn_ ids
    for (const c of USER_ID_COLUMNS) {
      const bad = await sql.unsafe(`SELECT "${c.column}" AS v FROM "${c.table}" WHERE "${c.column}" IS NOT NULL AND "${c.column}" !~ '^prn_[0-9a-f]{20}$'`);
      expect({ col: `${c.table}.${c.column}`, bad: bad.length }).toEqual({ col: `${c.table}.${c.column}`, bad: 0 });
    }
  });

  test("forward is idempotent: a second run finds everything already rewritten", async () => {
    const plan = await planRewrite(sql, { direction: "forward" });
    expect(plan.counts.every((c) => c.toRewrite === 0)).toBe(true);
    expect(plan.unmapped).toEqual([]);
    await applyRewrite(sql, { direction: "forward" }); // and applying it again is harmless
    expect((await sql`SELECT principal_id FROM hub_operators`).map((r) => r.principal_id)).toEqual([P2]);
  });

  test("reverse refuses a prn_ with no Better Auth id until --map names one", async () => {
    // A human who first signed in at the plane during the window wrote a row.
    await sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('k3', 'v', ${P3})`;
    const err = await applyRewrite(sql, { direction: "reverse", extra: { [P2]: U2 } }).catch((e) => e);
    expect(err).toBeInstanceOf(RewriteRefused);
    expect((err as RewriteRefused).plan.unmapped).toEqual([{ table: "system_settings", column: "updated_by", value: P3, rows: 1 }]);
    expect((await sql`SELECT updated_by FROM system_settings WHERE key = 'k1'`)[0]!.updated_by).toBe(P1);
  });

  test("reverse restores user ids and re-adds the FKs NOT VALID (a plane-only human's row would not block it)", async () => {
    // P3 keeps its prn_ (it has no user row): a VALIDATED FK could not be re-added over it.
    await applyRewrite(sql, { direction: "reverse", extra: { [P2]: U2, [P3]: P3 } });
    expect((await sql`SELECT updated_by FROM system_settings ORDER BY key`).map((r) => r.updated_by)).toEqual([U1, U2, P3]);
    const fk = await sql<{ convalidated: boolean }[]>`SELECT convalidated FROM pg_constraint WHERE conname = 'system_settings_updated_by_user_id_fk'`;
    expect([...fk]).toEqual([{ convalidated: false }]);
    const all = await sql<{ conname: string; convalidated: boolean; def: string }[]>`
      SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ANY(${USER_FKS})`;
    expect(all.map((r) => r.conname).sort()).toEqual([...USER_FKS].sort());
    expect(all.every((r) => r.convalidated === false)).toBe(true);
    for (const c of USER_ID_COLUMNS.filter((x) => x.fk)) {
      expect(all.find((r) => r.conname === c.fk)!.def).toBe(
        `FOREIGN KEY (${c.column}) REFERENCES "user"(id) ON DELETE ${c.onDelete} NOT VALID`,
      );
    }
    expect(await constraintDefs(OWNER_FKS)).toEqual(ownerDefs);
    await sql`DELETE FROM system_settings WHERE key = 'k3'`;
  });

  test("reverse twice is harmless: the FKs are not added a second time", async () => {
    await applyRewrite(sql, { direction: "reverse" });
    expect(Object.keys(await constraintDefs(USER_FKS))).toHaveLength(USER_FKS.length);
  });

  test("forward then reverse round-trips to identical data", async () => {
    const before = await snapshot();
    await applyRewrite(sql, { direction: "forward" });
    expect(await snapshot()).not.toEqual(before);
    await applyRewrite(sql, { direction: "reverse" });
    expect(await snapshot()).toEqual(before);
    expect(await constraintDefs(OWNER_FKS)).toEqual(ownerDefs);
  });

  test("a service's or agent's prn_ was never a user id: reverse leaves it alone instead of refusing", async () => {
    // Found rehearsing on a production copy: station_audit holds rows written by a service
    // principal (superwitness) under its prn_ long before any rewrite. Reverse must not demand a
    // Better Auth id for it, or the cutover's rollback is blocked.
    const SVC = "prn_4444444444444444dddd";
    const AGENT = "prn_5555555555555555eeee";
    await sql`INSERT INTO principals (id, kind, org_id, handle) VALUES (${SVC}, 'service', 'org_00000000000000000000', 'svc'), (${AGENT}, 'agent', 'org_00000000000000000000', 'agt')`;
    await sql`INSERT INTO station_audit (id, tenant_id, user_id, node_id, station_key, verb) VALUES ('a_svc', ${T}, ${SVC}, 'node_x', 's', 'v'), ('a_agt', ${T}, ${AGENT}, 'node_x', 's', 'v')`;
    try {
      const plan = await planRewrite(sql, { direction: "reverse" });
      expect(plan.unmapped).toEqual([]);
      await applyRewrite(sql, { direction: "forward" });
      await applyRewrite(sql, { direction: "reverse" });
      expect((await sql`SELECT id, user_id FROM station_audit WHERE id IN ('a_svc', 'a_agt') ORDER BY id`).map((r) => [r.id, r.user_id])).toEqual([
        ["a_agt", AGENT],
        ["a_svc", SVC],
      ]);
    } finally {
      await sql`DELETE FROM station_audit WHERE id IN ('a_svc', 'a_agt')`;
      await sql`DELETE FROM principals WHERE id IN (${SVC}, ${AGENT})`;
    }
  });
});

describe("the CLI", () => {
  const script = join(import.meta.dir, "..", "..", "scripts", "rewrite-user-ids.ts");
  const run = (args: string[], env: Record<string, string | undefined>) => {
    const p = Bun.spawnSync(["bun", "run", script, ...args], {
      env: { PATH: process.env.PATH, ...env },
      cwd: tmpdir(), // so bun loads no .env that could name a database
    });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };

  test("refuses to guess a database: DATABASE_URL is required", () => {
    const r = run([], { DATABASE_URL: undefined });
    expect(r.code).toBe(1);
    expect(r.out).toContain("DATABASE_URL must name the hub database explicitly");
    expect(r.out).not.toContain("database:"); // it never connected anywhere
  });

  test("a dry run names the unmapped value, exits 2, and changes nothing", async () => {
    await sql`INSERT INTO station_audit (id, tenant_id, user_id, node_id, station_key, verb) VALUES ('a9', ${T}, 'u-cli-orphan', 'node_x', 's', 'v')`;
    try {
      const before = await snapshot();
      const r = run([], { DATABASE_URL: SCRATCH_URL });
      expect(r.out).toContain("UNMAPPED");
      expect(r.out).toContain("u-cli-orphan");
      expect(r.out).toContain("Dry run");
      expect(r.code).toBe(2);
      expect(await snapshot()).toEqual(before);

      const j = run(["--json", "--map", `u-cli-orphan=${P1}`], { DATABASE_URL: SCRATCH_URL });
      expect(j.code).toBe(0);
      const plan = JSON.parse(j.out.slice(j.out.indexOf("{"), j.out.lastIndexOf("}") + 1));
      expect(plan.unmapped).toEqual([]);
      expect(plan.direction).toBe("forward");
      expect(await snapshot()).toEqual(before);
    } finally {
      await sql`DELETE FROM station_audit WHERE id = 'a9'`;
    }
  });

  test("an unknown flag is refused rather than ignored", () => {
    const r = run(["--aply"], { DATABASE_URL: SCRATCH_URL });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--aply");
  });
});
