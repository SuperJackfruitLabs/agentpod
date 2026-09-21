import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
const bundleDigests: Record<(typeof harnesses)[number], string> = {
  codex: "b955c59daedd145753d134dc32df73cdb772bc7f2ae822d624e20d6bea5639c6",
  "claude-code": "e8d4f41359ba42b588b4d7ff84e6e75c2459017456b7097ae41502a74fb1fe30",
  opencode: "cfb858e23901526626bae180b0992f6d1cfc79e54f8712f2ecec8cc6cfccf122",
  pi: "873bcf956060b8f6bb24afc2eeda4d2147304743a2e005eaf08cc89e83114100",
  hermes: "67c88cf8feee5c79d26446e4771da1b33cf87b1306a62e3613ae95e282a05f19",
  openclaw: "bafc88af798e69b670bc8cf14dd99bba2dd132d9efb0724d58010d325fd7cad5",
};
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
    const artifact = await storeSkillArtifact(owner, { harness, profile: "fixture" }, await readFile(new URL(`../../../node-agent/internal/skills/testdata/export-${harness}.tar.gz`, import.meta.url)));
    return { harness, artifactId: artifact.id, archive_sha256: artifact.archiveSHA256, bundle_digest: bundleDigests[harness] };
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
