import { and, eq, inArray } from "drizzle-orm";
import { SkillReleaseCohortCreateRequest, SkillReleaseCohortMetadata } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { skillReleaseCohorts } from "../db/schema/skills";
import { stations } from "../db/schema/stations";
import { tenantScope } from "../db/tenant-scope";
import { requireGrantReach } from "./grant-reach";
import { SkillRequestError, type SkillOwner } from "./skill-artifacts";
import { getTrustedSkillRelease } from "./trusted-skill-catalog";

const metadata = (row: typeof skillReleaseCohorts.$inferSelect) => SkillReleaseCohortMetadata.parse({
  id: row.id, releaseId: row.releaseId, recordDigest: row.recordDigest,
  stationIds: row.stationIds, createdAt: row.createdAt.toISOString(),
});

/** Creates one immutable audience only after every requested station is eligible. */
export async function createSkillReleaseCohort(owner: SkillOwner, raw: unknown) {
  const parsed = SkillReleaseCohortCreateRequest.safeParse(raw);
  if (!parsed.success) throw new SkillRequestError(400, "Invalid skill release cohort");
  const request = parsed.data;
  const release = await getTrustedSkillRelease(owner, request.releaseId);
  if (!release || release.recordDigest !== request.recordDigest)
    throw new SkillRequestError(409, "Trusted release identity changed or is unavailable");
  const rows = await db.select().from(stations).where(tenantScope(stations, owner.tenantId, eq(stations.userId, owner.userId), inArray(stations.id, request.stationIds)));
  if (rows.length !== request.stationIds.length)
    throw new SkillRequestError(409, "Every requested station must belong to this owner and tenant");
  const record = release.record as { artifacts: { harness: string }[] };
  for (const station of rows) {
    if (!record.artifacts.some((artifact) => artifact.harness === station.harness))
      throw new SkillRequestError(409, "A cohort station does not match a trusted release harness");
    await requireGrantReach(owner.userId, station, "skills.manage", "mutate");
  }
  const [created] = await db.insert(skillReleaseCohorts).values({ id: crypto.randomUUID(), ...owner, ...request }).returning();
  return metadata(created!);
}

export async function listSkillReleaseCohorts(owner: SkillOwner) {
  const rows = await db.select().from(skillReleaseCohorts).where(tenantScope(skillReleaseCohorts, owner.tenantId, eq(skillReleaseCohorts.userId, owner.userId))).orderBy(skillReleaseCohorts.createdAt).limit(128);
  return rows.map(metadata);
}
