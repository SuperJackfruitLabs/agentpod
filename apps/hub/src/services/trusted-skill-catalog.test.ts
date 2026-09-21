import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rawSql } from "../db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { storeSkillArtifact } from "./skill-artifacts";
import { importTrustedSkillRelease, listTrustedSkillReleases } from "./trusted-skill-catalog";

const owner = { userId: `test-trusted-release-${crypto.randomUUID()}`, tenantId: BOOTSTRAP_TENANT_ID };
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
  // The local development database may have applied an earlier draft of this
  // migration with a restrictive artifact FK.  Production migration 0072
  // cascades this mapping; explicit test cleanup keeps the fixture portable.
  await rawSql`DELETE FROM trusted_skill_release_artifacts WHERE user_id=${owner.userId}`;
  await rawSql`DELETE FROM "user" WHERE id=${owner.userId}`;
});

test("a trusted release atomically binds every canonical harness archive", async () => {
  const pins = await Promise.all(harnesses.map(async (harness) => {
    const bytes = Buffer.from(`synthetic immutable ${harness}`);
    const artifact = await storeSkillArtifact(owner, { harness, profile: "fixture" }, bytes);
    return { harness, artifactId: artifact.id, archive_sha256: artifact.archiveSHA256, bundle_digest: createHash("sha256").update(`bundle:${harness}`).digest("hex") };
  }));
  const unsigned = {
    schema_version: 1 as const, version: "1.2.3", profile: "fixture", visibility: "private" as const,
    artifacts: pins.map(({ harness, archive_sha256, bundle_digest }) => ({ harness, archive_sha256, bundle_digest, path: `archives/${harness}/sjl-fixture.tar.gz` })),
  };
  const record = { ...unsigned, digest: createHash("sha256").update(canonical(unsigned)).digest("hex") };
  const first = await importTrustedSkillRelease(owner, record, pins.map(({ harness, artifactId }) => ({ harness, artifactId })));
  const again = await importTrustedSkillRelease(owner, record, pins.map(({ harness, artifactId }) => ({ harness, artifactId })));
  expect(again.id).toBe(first.id);
  expect(await listTrustedSkillReleases(owner)).toEqual([first]);
  await expect(importTrustedSkillRelease(owner, { ...record, digest: "0".repeat(64) }, pins.map(({ harness, artifactId }) => ({ harness, artifactId })))).rejects.toThrow("digest mismatch");
  await expect(importTrustedSkillRelease(owner, record, pins.slice(1).map(({ harness, artifactId }) => ({ harness, artifactId })))).rejects.toThrow("exactly one artifact");
});
