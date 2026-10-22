process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { tenantForOrg } from "../../src/auth/org-plane/tenant";

/**
 * Workspace authority spec, step 4 (W4): a station, a skill artifact and a trusted release are the
 * workspace's, so a second admin of the workspace can act on what the first one created. Before
 * migration 0114 five composite foreign keys made that unrepresentable: they bound a child row's
 * `user_id` to its parent's, so the second admin's setup receipt, skill operation, release pin or
 * cohort violated a key no matter what the routes allowed.
 */

const RUN = crypto.randomUUID().slice(0, 8);
const T = BOOTSTRAP_TENANT_ID;
let FIRST: string; // adopted the station, uploaded the artifact, imported the release
let SECOND: string; // another admin of the same workspace
const NODE = `node_wok_${RUN}`;
const STATION = `station_wok_${RUN}`;
const ARTIFACT = crypto.randomUUID();
const RELEASE = `rel_wok_${RUN}`;
const DIGEST = "a".repeat(56) + RUN;

beforeAll(async () => {
  await ensurePgMigrations();
  FIRST = (await createTestUser({ email: `wok-1-${RUN}@example.com` })).id;
  SECOND = (await createTestUser({ email: `wok-2-${RUN}@example.com` })).id;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${T}, ${FIRST}, ${NODE}, 'h', 'linux', 'amd64', 2, 'offline', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${STATION}, ${T}, ${FIRST}, ${NODE}, 'codex', ${"codex:" + RUN}, 'leaf', 'wok', '[]'::jsonb, now(), now())`;
  await rawSql`
    INSERT INTO skill_artifacts (id, tenant_id, user_id, archive_sha256, harness, profile, size, bytes)
    VALUES (${ARTIFACT}, ${T}, ${FIRST}, ${DIGEST}, 'codex', 'wok', 1, decode('61','hex'))`;
  await rawSql`
    INSERT INTO trusted_skill_releases (id, tenant_id, user_id, version, profile, record_digest, record)
    VALUES (${RELEASE}, ${T}, ${FIRST}, ${"0.0." + RUN}, 'wok', ${DIGEST}, '{}'::jsonb)`;
});

afterAll(async () => {
  await rawSql`DELETE FROM skill_release_cohorts WHERE release_id = ${RELEASE}`;
  await rawSql`DELETE FROM trusted_skill_release_artifacts WHERE release_id = ${RELEASE}`;
  await rawSql`DELETE FROM skill_operations WHERE station_id = ${STATION}`;
  await rawSql`DELETE FROM station_setups WHERE station_id = ${STATION}`;
  await rawSql`DELETE FROM trusted_skill_releases WHERE id = ${RELEASE}`;
  await rawSql`DELETE FROM skill_artifacts WHERE id = ${ARTIFACT}`;
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await deleteTestUsers([FIRST, SECOND]);
});

describe("a second admin can act on what the first created (W4)", () => {
  test("a setup receipt at a station another member adopted", async () => {
    await rawSql`
      INSERT INTO station_setups (request_id, station_id, tenant_id, user_id, input, principal_id)
      VALUES (${"req_wok_" + RUN}, ${STATION}, ${T}, ${SECOND}, '{}', 'prn_00000000000000000000')`;
  });

  test("a skill operation installing another member's artifact on another member's station", async () => {
    await rawSql`
      INSERT INTO skill_operations (id, tenant_id, user_id, station_id, node_id, station_key, harness, profile, kind, action, artifact_id)
      VALUES (${"b".repeat(24) + RUN}, ${T}, ${SECOND}, ${STATION}, ${NODE}, ${"codex:" + RUN}, 'codex', 'wok', 'managed', 'install', ${ARTIFACT})`;
  });

  test("a release pin and a cohort on another member's release and artifact", async () => {
    await rawSql`
      INSERT INTO trusted_skill_release_artifacts (release_id, tenant_id, user_id, artifact_id, harness, bundle_digest)
      VALUES (${RELEASE}, ${T}, ${SECOND}, ${ARTIFACT}, 'codex', ${DIGEST})`;
    await rawSql`
      INSERT INTO skill_release_cohorts (id, tenant_id, user_id, release_id, record_digest, station_ids)
      VALUES (${"coh_wok_" + RUN}, ${T}, ${SECOND}, ${RELEASE}, ${DIGEST}, ${JSON.stringify([STATION])}::jsonb)`;
  });
});

describe("the keys still hold the workspace boundary", () => {
  test("a setup receipt cannot name another tenant than its station's", async () => {
    const b = await tenantForOrg({ org: "org_44444444444444444444", ent: ["agentpod"] });
    if (!b.ok) throw new Error("tenant resolution refused");
    const other = b.tenantId;
    const err = await rawSql`
      INSERT INTO station_setups (request_id, station_id, tenant_id, user_id, input, principal_id)
      VALUES (${"req_wok_x_" + RUN}, ${STATION}, ${other}, ${SECOND}, '{}', 'prn_00000000000000000000')`.catch((e) => e);
    expect(String(err)).toContain("station_setups_station_tenant_fk");
  });

  test("a skill operation cannot pin an artifact from another tenant", async () => {
    const err = await rawSql`
      INSERT INTO skill_operations (id, tenant_id, user_id, station_id, node_id, station_key, harness, profile, kind, action, artifact_id)
      VALUES (${"c".repeat(24) + RUN}, ${T}, ${SECOND}, ${STATION}, ${NODE}, ${"codex:" + RUN}, 'codex', 'wok', 'managed', 'install', ${crypto.randomUUID()})`.catch((e) => e);
    expect(String(err)).toContain("skill_operations_artifact_tenant_fk");
  });
});
