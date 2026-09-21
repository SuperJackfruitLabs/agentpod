import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  TrustedSkillReleaseMetadata,
  TrustedSkillReleaseRecord,
} from "@agentpod/contract";
import { db } from "../db/drizzle";
import {
  skillArtifacts,
  trustedSkillReleaseArtifacts,
  trustedSkillReleases,
} from "../db/schema/skills";
import { tenantScope } from "../db/tenant-scope";
import { SkillRequestError, type SkillOwner } from "./skill-artifacts";

type CatalogPin = { harness: string; artifactId: string };

/** Matches the canonical JSON bytes used by sjl-skills common.json_bytes. */
function canonicalReleaseBytes(value: unknown): Buffer {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  };
  return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, "utf8");
}

function metadata(row: typeof trustedSkillReleases.$inferSelect) {
  return TrustedSkillReleaseMetadata.parse({
    id: row.id,
    version: row.version,
    profile: row.profile,
    recordDigest: row.recordDigest,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Imports a complete SJL library release.  Artifacts must already be private
 * immutable blobs owned by the same caller; their bytes, profile and harness
 * are checked against the release record in the same transaction.
 */
export async function importTrustedSkillRelease(
  owner: SkillOwner,
  rawRecord: unknown,
  rawPins: readonly CatalogPin[],
): Promise<TrustedSkillReleaseMetadata> {
  const parsed = TrustedSkillReleaseRecord.safeParse(rawRecord);
  if (!parsed.success) throw new SkillRequestError(400, "Invalid trusted release record");
  const record = parsed.data;
  const unsigned = { ...record } as Record<string, unknown>;
  delete unsigned.digest;
  const actualDigest = createHash("sha256").update(canonicalReleaseBytes(unsigned)).digest("hex");
  if (actualDigest !== record.digest)
    throw new SkillRequestError(409, "Trusted release record digest mismatch");
  if (rawPins.length !== record.artifacts.length || new Set(rawPins.map((pin) => pin.harness)).size !== rawPins.length)
    throw new SkillRequestError(400, "Trusted release must bind exactly one artifact per harness");

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["trusted-skill-releases", owner.tenantId, owner.userId, record.digest])},0))`);
    const releaseScope = tenantScope(trustedSkillReleases, owner.tenantId, eq(trustedSkillReleases.userId, owner.userId));
    const [existing] = await tx.select().from(trustedSkillReleases).where(and(releaseScope, eq(trustedSkillReleases.recordDigest, record.digest)));
    if (existing) return metadata(existing);
    const pins = new Map(rawPins.map((pin) => [pin.harness, pin.artifactId]));
    const resolved = await Promise.all(record.artifacts.map(async (expected) => {
      const artifactId = pins.get(expected.harness);
      if (!artifactId) throw new SkillRequestError(400, "Trusted release is missing a pinned harness artifact");
      const [artifact] = await tx.select().from(skillArtifacts).where(tenantScope(skillArtifacts, owner.tenantId, eq(skillArtifacts.userId, owner.userId), eq(skillArtifacts.id, artifactId)));
      if (!artifact || artifact.harness !== expected.harness || artifact.profile !== record.profile || artifact.archiveSHA256 !== expected.archive_sha256)
        throw new SkillRequestError(409, "Pinned artifact does not match the trusted release record");
      return { expected, artifact };
    }));
    const [conflict] = await tx.select({ id: trustedSkillReleases.id }).from(trustedSkillReleases).where(and(releaseScope, eq(trustedSkillReleases.version, record.version), eq(trustedSkillReleases.profile, record.profile)));
    if (conflict) throw new SkillRequestError(409, "Version and profile already identify a different trusted release");
    const [created] = await tx.insert(trustedSkillReleases).values({
      id: crypto.randomUUID(),
      ...owner,
      version: record.version,
      profile: record.profile,
      recordDigest: record.digest,
      record,
    }).returning();
    await tx.insert(trustedSkillReleaseArtifacts).values(resolved.map(({ expected, artifact }) => ({
      releaseId: created!.id,
      ...owner,
      artifactId: artifact.id,
      harness: expected.harness,
      bundleDigest: expected.bundle_digest,
    })));
    return metadata(created!);
  });
}

export async function listTrustedSkillReleases(owner: SkillOwner): Promise<TrustedSkillReleaseMetadata[]> {
  const rows = await db.select().from(trustedSkillReleases)
    .where(tenantScope(trustedSkillReleases, owner.tenantId, eq(trustedSkillReleases.userId, owner.userId)))
    .orderBy(trustedSkillReleases.createdAt).limit(128);
  return rows.map(metadata);
}
