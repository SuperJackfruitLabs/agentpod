import { eq } from "drizzle-orm";
import {
  SkillReleaseCanaryOperation,
  SkillReleaseCanaryOperationRequest,
  SkillReleaseCanaryPlanRequest,
} from "@agentpod/contract";
import { db } from "../db/drizzle";
import { stations, trustedSkillReleaseArtifacts } from "../db/schema";
import { tenantScope } from "../db/tenant-scope";
import { requireGrantReach } from "./grant-reach";
import { createSkillOperation, getSkillOperation } from "./skill-operations";
import { getSkillReleaseCohort } from "./skill-release-cohorts";
import { getTrustedSkillRelease } from "./trusted-skill-catalog";
import { SkillRequestError, type SkillOwner } from "./skill-artifacts";

/**
 * Creates the managed operation for exactly one named cohort member.  This is
 * intentionally preparation only: applying the package remains a separate,
 * digest-reviewed action after the operator has examined the node plan.
 */
export async function createSkillReleaseCanaryOperation(
  owner: SkillOwner,
  cohortId: string,
  raw: unknown,
) {
  const parsed = SkillReleaseCanaryPlanRequest.safeParse(raw);
  if (!parsed.success) throw new SkillRequestError(400, "Invalid skill release canary request");
  const request = parsed.data;
  const cohort = await getSkillReleaseCohort(owner, cohortId);
  if (!cohort || cohort.releaseId !== request.releaseId || cohort.recordDigest !== request.recordDigest)
    throw new SkillRequestError(409, "Cohort release identity changed or is unavailable");
  if (!cohort.stationIds.includes(request.stationId))
    throw new SkillRequestError(409, "Canary station is not an explicit member of this cohort");
  const release = await getTrustedSkillRelease(owner, request.releaseId);
  if (!release || release.recordDigest !== request.recordDigest)
    throw new SkillRequestError(409, "Trusted release identity changed or is unavailable");
  const [station] = await db.select().from(stations).where(
    tenantScope(stations, owner.tenantId, eq(stations.userId, owner.userId), eq(stations.id, request.stationId)),
  );
  if (!station) throw new SkillRequestError(409, "Canary station is no longer available to this owner");
  if (!station.capabilities?.includes("skills.manage"))
    throw new SkillRequestError(409, "Canary station does not advertise skill management");
  await requireGrantReach(owner.userId, station, "skills.manage", "mutate");
  const [pin] = await db.select().from(trustedSkillReleaseArtifacts).where(
    tenantScope(
      trustedSkillReleaseArtifacts,
      owner.tenantId,
      eq(trustedSkillReleaseArtifacts.userId, owner.userId),
      eq(trustedSkillReleaseArtifacts.releaseId, release.id),
      eq(trustedSkillReleaseArtifacts.harness, station.harness),
    ),
  );
  if (!pin) throw new SkillRequestError(409, "Trusted release has no artifact for the canary harness");
  const operation = await createSkillOperation(owner, station, {
    requestId: request.requestId,
    artifactId: pin.artifactId,
  });
  return SkillReleaseCanaryOperation.parse({
    cohortId,
    releaseId: release.id,
    recordDigest: release.recordDigest,
    stationId: station.id,
    operationId: operation.id,
  });
}

/** Resolves a previously prepared canary before it may be inspected or applied. */
export async function getSkillReleaseCanaryOperation(
  owner: SkillOwner,
  cohortId: string,
  raw: unknown,
) {
  const parsed = SkillReleaseCanaryOperationRequest.safeParse(raw);
  if (!parsed.success) throw new SkillRequestError(400, "Invalid skill release canary operation");
  const request = parsed.data;
  const cohort = await getSkillReleaseCohort(owner, cohortId);
  if (!cohort || cohort.releaseId !== request.releaseId || cohort.recordDigest !== request.recordDigest)
    throw new SkillRequestError(409, "Cohort release identity changed or is unavailable");
  if (!cohort.stationIds.includes(request.stationId))
    throw new SkillRequestError(409, "Canary station is not an explicit member of this cohort");
  const release = await getTrustedSkillRelease(owner, request.releaseId);
  if (!release || release.recordDigest !== request.recordDigest)
    throw new SkillRequestError(409, "Trusted release identity changed or is unavailable");
  const [station] = await db.select().from(stations).where(
    tenantScope(stations, owner.tenantId, eq(stations.userId, owner.userId), eq(stations.id, request.stationId)),
  );
  if (!station) throw new SkillRequestError(409, "Canary station is no longer available to this owner");
  const [pin] = await db.select().from(trustedSkillReleaseArtifacts).where(
    tenantScope(trustedSkillReleaseArtifacts, owner.tenantId, eq(trustedSkillReleaseArtifacts.userId, owner.userId), eq(trustedSkillReleaseArtifacts.releaseId, release.id), eq(trustedSkillReleaseArtifacts.harness, station.harness)),
  );
  if (!pin) throw new SkillRequestError(409, "Trusted release has no artifact for the canary harness");
  const operation = await getSkillOperation(owner, station, request.operationId);
  if (operation.action !== "install" || operation.artifactId !== pin.artifactId)
    throw new SkillRequestError(409, "Operation is not the trusted canary artifact for this cohort");
  return { station, operation };
}
