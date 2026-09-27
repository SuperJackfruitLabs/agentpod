import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  SkillArtifactMetadata,
  SkillArtifactUploadQuery,
} from "@agentpod/contract";
import { db } from "../db/drizzle";
import {
  skillArtifacts,
  skillOperations,
  trustedSkillReleaseArtifacts,
} from "../db/schema/skills";
import { tenantScope, assertTenantId } from "../db/tenant-scope";

export type SkillOwner = { tenantId: string; userId: string };
export class SkillRequestError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 502,
    message: string,
  ) {
    super(message);
  }
}
export const MAX_SKILL_ARTIFACT_BYTES = 32 << 20;
const metadataColumns = {
  id: skillArtifacts.id,
  archiveSHA256: skillArtifacts.archiveSHA256,
  harness: skillArtifacts.harness,
  profile: skillArtifacts.profile,
  size: skillArtifacts.size,
  createdAt: skillArtifacts.createdAt,
};
export async function listSkillArtifacts(
  owner: SkillOwner,
): Promise<SkillArtifactMetadata[]> {
  const rows = await db
    .select(metadataColumns)
    .from(skillArtifacts)
    .where(
      tenantScope(
        skillArtifacts,
        owner.tenantId,
        eq(skillArtifacts.userId, owner.userId),
      ),
    )
    .orderBy(skillArtifacts.createdAt)
    .limit(256);
  return rows.map((row) =>
    SkillArtifactMetadata.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      validation: "unverified",
    }),
  );
}
export async function getSkillArtifact(owner: SkillOwner, id: string) {
  const [row] = await db
    .select()
    .from(skillArtifacts)
    .where(
      tenantScope(
        skillArtifacts,
        owner.tenantId,
        eq(skillArtifacts.userId, owner.userId),
        eq(skillArtifacts.id, id),
      ),
    );
  return row ?? null;
}
export async function getSkillArtifactMetadata(
  owner: SkillOwner,
  id: string,
): Promise<SkillArtifactMetadata | null> {
  const [row] = await db
    .select(metadataColumns)
    .from(skillArtifacts)
    .where(
      tenantScope(
        skillArtifacts,
        owner.tenantId,
        eq(skillArtifacts.userId, owner.userId),
        eq(skillArtifacts.id, id),
      ),
    );
  return row
    ? SkillArtifactMetadata.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
        validation: "unverified",
      })
    : null;
}
export async function storeSkillArtifact(
  owner: SkillOwner,
  declaration: unknown,
  bytes: Buffer,
): Promise<SkillArtifactMetadata> {
  assertTenantId(owner.tenantId);
  const parsed = SkillArtifactUploadQuery.safeParse(declaration);
  if (!owner.userId || owner.userId === "anonymous" || !parsed.success)
    throw new SkillRequestError(400, "Invalid artifact metadata");
  if (bytes.length === 0 || bytes.length > MAX_SKILL_ARTIFACT_BYTES)
    throw new SkillRequestError(413, "Artifact must contain 1–33554432 bytes");
  const archiveSHA256 = createHash("sha256").update(bytes).digest("hex");
  return db.transaction(async (tx) => {
    // Serialize quota accounting for this owner across processes, not just requests.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["skill-artifacts", owner.tenantId, owner.userId])},0))`,
    );
    const where = tenantScope(
      skillArtifacts,
      owner.tenantId,
      eq(skillArtifacts.userId, owner.userId),
    );
    const [existing] = await tx
      .select(metadataColumns)
      .from(skillArtifacts)
      .where(and(where, eq(skillArtifacts.archiveSHA256, archiveSHA256)));
    if (existing) {
      if (
        existing.harness !== parsed.data.harness ||
        existing.profile !== parsed.data.profile
      )
        throw new SkillRequestError(
          409,
          "Identical bytes already have different declared metadata",
        );
      return SkillArtifactMetadata.parse({
        ...existing,
        createdAt: existing.createdAt.toISOString(),
        validation: "unverified",
      });
    }
    const [usage] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        size: sql<number>`coalesce(sum(${skillArtifacts.size}),0)::bigint`,
      })
      .from(skillArtifacts)
      .where(where);
    if (
      Number(usage?.count) >= 256 ||
      Number(usage?.size) + bytes.length > 128 << 20
    )
      throw new SkillRequestError(409, "Artifact retention limit reached");
    const [row] = await tx
      .insert(skillArtifacts)
      .values({
        id: crypto.randomUUID(),
        ...owner,
        ...parsed.data,
        archiveSHA256,
        size: bytes.length,
        bytes,
      })
      .returning(metadataColumns);
    return SkillArtifactMetadata.parse({
      ...row!,
      createdAt: row!.createdAt.toISOString(),
      validation: "unverified",
    });
  });
}
export async function deleteSkillArtifact(
  owner: SkillOwner,
  id: string,
): Promise<boolean> {
  const [deleted] = await db
    .delete(skillArtifacts)
    .where(
      tenantScope(
        skillArtifacts,
        owner.tenantId,
        eq(skillArtifacts.userId, owner.userId),
        eq(skillArtifacts.id, id),
        sql`NOT EXISTS (SELECT 1 FROM ${skillOperations} WHERE ${skillOperations.artifactId}=${skillArtifacts.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${trustedSkillReleaseArtifacts} WHERE ${trustedSkillReleaseArtifacts.artifactId}=${skillArtifacts.id} AND ${trustedSkillReleaseArtifacts.tenantId}=${skillArtifacts.tenantId} AND ${trustedSkillReleaseArtifacts.userId}=${skillArtifacts.userId})`,
      ),
    )
    .returning({ id: skillArtifacts.id });
  return !!deleted;
}
