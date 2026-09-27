import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { rawSql } from "../db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { storeSkillArtifact } from "./skill-artifacts";
import { importTrustedSkillRelease, listTrustedSkillReleases } from "./trusted-skill-catalog";
import { validateTrustedSkillArchive } from "./trusted-skill-archive";

const owner = { userId: `test-trusted-release-${crypto.randomUUID()}`, tenantId: BOOTSTRAP_TENANT_ID };
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
  // The local development database may have applied an earlier draft of this
  // migration with a restrictive artifact FK.  Production migration 0072
  // cascades this mapping; explicit test cleanup keeps the fixture portable.
  await rawSql`DELETE FROM trusted_skill_release_artifacts WHERE user_id=${owner.userId}`;
  await rawSql`DELETE FROM "user" WHERE id=${owner.userId}`;
});

test("a trusted release atomically binds every canonical harness archive", async () => {
  const pins = await Promise.all(harnesses.map(async (harness) => {
    const bytes = await readFile(new URL(`../../../node-agent/internal/skills/testdata/export-${harness}.tar.gz`, import.meta.url));
    const artifact = await storeSkillArtifact(owner, { harness, profile: "fixture" }, bytes);
    return { harness, artifactId: artifact.id, archive_sha256: artifact.archiveSHA256, bundle_digest: bundleDigests[harness] };
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

test("admission rejects a changed declared harness or corrupt archive before catalog pinning", async () => {
  const bytes = await readFile(new URL("../../../node-agent/internal/skills/testdata/export-codex.tar.gz", import.meta.url));
  const archiveSHA256 = createHash("sha256").update(bytes).digest("hex");
  expect(() => validateTrustedSkillArchive(bytes, {
    archiveSHA256, harness: "pi", profile: "fixture", bundleDigest: bundleDigests.codex,
  })).toThrow("bundle identity mismatch");
  const corrupt = Buffer.from(bytes);
  const last = corrupt.length - 1;
  corrupt[last] = corrupt[last]! ^ 1;
  expect(() => validateTrustedSkillArchive(corrupt, {
    archiveSHA256: createHash("sha256").update(corrupt).digest("hex"), harness: "codex", profile: "fixture", bundleDigest: bundleDigests.codex,
  })).toThrow();
});
