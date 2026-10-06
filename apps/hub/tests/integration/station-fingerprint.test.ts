/**
 * Resolving what a station is running, from rows the hub already holds.
 * DATABASE_URL must point at the local test-postgres on :5434.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { db, rawSql } from "../../src/db/drizzle";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { appliedSkillRelease, resolveStationFingerprint, resolveStationOccupant } from "../../src/services/evidence/station-fingerprint";
import { fingerprintDigest } from "../../src/services/evidence/fingerprint";
import { createPrincipal, forgetPrincipals } from "../helpers/principals";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const USER = `station-fp-${crypto.randomUUID()}`;
const NODE = `node_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const STATION = `station_${crypto.randomUUID()}`;
const hex = (c: string) => c.repeat(64);
const opId = () => crypto.randomUUID().replaceAll("-", "");

async function artifact(profile: string, digestChar: string): Promise<string> {
  const id = crypto.randomUUID();
  await rawSql`INSERT INTO skill_artifacts (id, tenant_id, user_id, archive_sha256, harness, profile, size, bytes)
               VALUES (${id}, ${BOOTSTRAP_TENANT_ID}, ${USER}, ${hex(digestChar)}, 'hermes', ${profile}, 1, ${Buffer.from("x")})`;
  return id;
}

async function trustedRelease(artifactId: string, profile: string, version: string, recordChar: string) {
  const id = crypto.randomUUID();
  await rawSql`INSERT INTO trusted_skill_releases (id, tenant_id, user_id, version, profile, record_digest, record)
               VALUES (${id}, ${BOOTSTRAP_TENANT_ID}, ${USER}, ${version}, ${profile}, ${hex(recordChar)}, ${"{}"}::jsonb)`;
  await rawSql`INSERT INTO trusted_skill_release_artifacts (release_id, tenant_id, user_id, artifact_id, harness, bundle_digest)
               VALUES (${id}, ${BOOTSTRAP_TENANT_ID}, ${USER}, ${artifactId}, 'hermes', ${hex("f")})`;
}

async function applied(profile: string, action: "install" | "rollback", artifactId: string | null, at: Date) {
  await rawSql`INSERT INTO skill_operations (id, tenant_id, user_id, station_id, node_id, station_key, harness, profile, kind, action, artifact_id, state, created_at, updated_at)
               VALUES (${opId()}, ${BOOTSTRAP_TENANT_ID}, ${USER}, ${STATION}, ${NODE}, 'hermes:press', 'hermes', ${profile}, 'managed', ${action}, ${artifactId}, 'applied', ${at.toISOString()}, ${at.toISOString()})`;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER });
  await db.insert(nodes).values({
    id: NODE, userId: USER, tenantId: BOOTSTRAP_TENANT_ID, name: "fp", hostname: "fp", os: "linux", arch: "arm64",
    secretHash: "x",
  });
  await db.insert(stations).values({
    id: STATION, userId: USER, tenantId: BOOTSTRAP_TENANT_ID, nodeId: NODE, harness: "hermes",
    stationKey: "hermes:press", kind: "composite", displayName: "press",
  });
});

afterAll(async () => {
  await rawSql`DELETE FROM skill_operations WHERE user_id = ${USER}`;
  await rawSql`DELETE FROM trusted_skill_releases WHERE user_id = ${USER}`;
  await rawSql`DELETE FROM skill_artifacts WHERE user_id = ${USER}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await deleteTestUser(USER);
});

describe("resolveStationFingerprint", () => {
  test("a station with no skills: harness and profile from the row, nothing else claimed", async () => {
    const f = await resolveStationFingerprint(BOOTSTRAP_TENANT_ID, STATION);
    expect(f).toMatchObject({
      harness: "hermes", profile: "press", harness_version: "unknown", model: "unknown",
      skill_release: "none", reported_by: "hub",
    });
    expect(f.digest).toBe(fingerprintDigest(f));
  });

  test("a station that does not exist (or is in another tenant) is all unknown, not an error", async () => {
    const f = await resolveStationFingerprint(BOOTSTRAP_TENANT_ID, `station_${crypto.randomUUID()}`);
    expect(f).toMatchObject({ harness: "unknown", profile: "unknown", skill_release: "unknown", reported_by: "hub" });
  });

  test("the latest applied trusted install per skill profile names the release", async () => {
    const a = await artifact("press", "1");
    await trustedRelease(a, "press", "1.2.0", "a");
    await applied("press", "install", a, new Date("2026-10-01T00:00:00Z"));
    expect(await appliedSkillRelease(BOOTSTRAP_TENANT_ID, STATION)).toBe(`press@1.2.0:sha256:${hex("a")}`);

    const b = await artifact("base", "2");
    await trustedRelease(b, "base", "0.3.0", "b");
    await applied("base", "install", b, new Date("2026-10-01T00:00:00Z"));
    expect(await appliedSkillRelease(BOOTSTRAP_TENANT_ID, STATION)).toBe(
      `base@0.3.0:sha256:${hex("b")},press@1.2.0:sha256:${hex("a")}`,
    );
  });

  test("a rollback after the install makes the release unknown rather than stale", async () => {
    await applied("press", "rollback", null, new Date("2026-10-02T00:00:00Z"));
    expect(await appliedSkillRelease(BOOTSTRAP_TENANT_ID, STATION)).toBe("unknown");
  });

  test("an install of an artifact no trusted release pins is unknown", async () => {
    const c = await artifact("press", "3");
    await applied("press", "install", c, new Date("2026-10-03T00:00:00Z"));
    expect(await appliedSkillRelease(BOOTSTRAP_TENANT_ID, STATION)).toBe("unknown");
  });
});

describe("resolveStationOccupant", () => {
  test("names the agent principal occupying the station, and null once it is vacated", async () => {
    const prn = await createPrincipal({ kind: "agent", handle: `station-fp-occ-${crypto.randomUUID().slice(0, 8)}` });
    await rawSql`UPDATE stations SET principal_id = ${prn} WHERE id = ${STATION}`;
    expect(await resolveStationOccupant(BOOTSTRAP_TENANT_ID, STATION)).toBe(prn);
    await rawSql`UPDATE stations SET principal_id = NULL WHERE id = ${STATION}`;
    expect(await resolveStationOccupant(BOOTSTRAP_TENANT_ID, STATION)).toBeNull();
    await forgetPrincipals({ ids: [prn] });
  });

  test("an occupant id that is not a well-formed principal id is none, not a value the attempt insert would reject", async () => {
    // stations.principal_id is plain text since the hub's principals table went (P3 Task 17);
    // acp_runs.agent_principal_id is CHECKed ^prn_[0-9a-f]{20}$.
    const bad = "prn_NOT-HEX";
    await rawSql`UPDATE stations SET principal_id = ${bad} WHERE id = ${STATION}`;
    try {
      expect(await resolveStationOccupant(BOOTSTRAP_TENANT_ID, STATION)).toBeNull();
    } finally {
      await rawSql`UPDATE stations SET principal_id = NULL WHERE id = ${STATION}`;
    }
  });

  test("an unknown station has no occupant, and is not an error", async () => {
    expect(await resolveStationOccupant(BOOTSTRAP_TENANT_ID, `station_${crypto.randomUUID()}`)).toBeNull();
  });
});
