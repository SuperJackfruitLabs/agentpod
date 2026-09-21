import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { db, rawSql } from "../db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { nodes, stations } from "../db/schema";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { storeSkillArtifact } from "./skill-artifacts";
import { importTrustedSkillRelease } from "./trusted-skill-catalog";
import { createSkillReleaseCohort } from "./skill-release-cohorts";
import { createSkillReleaseCanaryOperation, getSkillReleaseCanaryOperation } from "./skill-release-canary";

const owner = { userId: `test-release-canary-${crypto.randomUUID()}`, tenantId: BOOTSTRAP_TENANT_ID };
const harnesses = ["codex", "claude-code", "opencode", "pi", "hermes", "openclaw"] as const;
const canonical = (value: unknown) => {
  const walk = (item: unknown): unknown => Array.isArray(item) ? item.map(walk) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, walk(child)]))
    : item;
  return Buffer.from(`${JSON.stringify(walk(value), null, 2)}\n`);
};

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: owner.userId });
});
afterAll(async () => {
  // A pre-0072 local development database can retain the older restrictive
  // artifact FK; remove mappings explicitly so this fixture works on both.
  await rawSql`DELETE FROM trusted_skill_release_artifacts WHERE user_id=${owner.userId}`;
  await rawSql`DELETE FROM "user" WHERE id=${owner.userId}`;
});

test("a canary creates an operation only for the exact pinned cohort member and harness artifact", async () => {
  const nodeId = `node-canary-${crypto.randomUUID()}`;
  const stationId = `station-canary-${crypto.randomUUID()}`;
  await db.insert(nodes).values({
    id: nodeId, ...owner, name: nodeId, hostname: "canary.local", os: "linux", arch: "amd64", secretHash: "x",
  });
  await db.insert(stations).values({
    id: stationId, ...owner, nodeId, stationKey: "canary", harness: "codex", kind: "agent", displayName: "Canary", capabilities: ["skills.manage"],
  });
  const pins = await Promise.all(harnesses.map(async (harness) => {
    const artifact = await storeSkillArtifact(owner, { harness, profile: "fixture" }, Buffer.from(`fixture ${harness}`));
    return { harness, artifactId: artifact.id, archive_sha256: artifact.archiveSHA256, bundle_digest: createHash("sha256").update(`bundle:${harness}`).digest("hex") };
  }));
  const unsigned = {
    schema_version: 1 as const, version: "1.2.3", profile: "fixture", visibility: "private" as const,
    artifacts: pins.map(({ harness, archive_sha256, bundle_digest }) => ({ harness, archive_sha256, bundle_digest, path: `archives/${harness}/sjl-fixture.tar.gz` })),
  };
  const release = await importTrustedSkillRelease(owner, { ...unsigned, digest: createHash("sha256").update(canonical(unsigned)).digest("hex") }, pins.map(({ harness, artifactId }) => ({ harness, artifactId })));
  const cohort = await createSkillReleaseCohort(owner, { releaseId: release.id, recordDigest: release.recordDigest, stationIds: [stationId] });
  const canary = await createSkillReleaseCanaryOperation(owner, cohort.id, {
    releaseId: release.id, recordDigest: release.recordDigest, stationId, requestId: "first-run",
  });
  expect(canary).toMatchObject({ cohortId: cohort.id, releaseId: release.id, stationId });
  expect((await getSkillReleaseCanaryOperation(owner, cohort.id, {
    releaseId: release.id, recordDigest: release.recordDigest, stationId, operationId: canary.operationId,
  })).operation.id).toBe(canary.operationId);
  await expect(createSkillReleaseCanaryOperation(owner, cohort.id, {
    releaseId: release.id, recordDigest: release.recordDigest, stationId: "other-station", requestId: "must-not-create",
  })).rejects.toThrow("not an explicit member");
});
