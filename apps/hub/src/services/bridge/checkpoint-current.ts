/** Fresh background-work authority. No workspace-admin exception and no display-directory cache. */
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db, type DbExecutor } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { tenants } from "../../db/schema/tenants";
import { nodes } from "../../db/schema/nodes";
import { bridgeAgents } from "../../db/schema/bridge";
import { orgPlaneClient } from "../../auth/org-plane/client";
import { grantAllowsPrincipal } from "../../auth/org-plane/grants";
import { connectionManager } from "../broker";
import { isControlPairEnforced } from "../control";
import { canonicalCheckpoint } from "./checkpoint-json";
import { CheckpointRefused, normalizeRosterProfileKey, type CheckpointProfile } from "./checkpoint-profile";

export interface CheckpointAuthority {
  organizationId: string;
  tenantId: string;
  sourceTenantId: string;
  stationId: string;
  nodeId: string;
  occupancyEpoch: number;
  principalId: string;
  ownerPrincipalId: string;
  agentKey: string;
  profileKey: string;
  rosterRevision: string;
  /** Domain-prefixed digest of actual selected authorization, never an issuer grant identifier. */
  authorizationSnapshotId: string;
}
const text = z.string().min(1).max(200);
const authoritySchema = z.object({ organizationId: text, tenantId: text, sourceTenantId: text,
  stationId: text, nodeId: text, occupancyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  principalId: text, ownerPrincipalId: text, agentKey: text, profileKey: z.union([z.literal(""), text]), rosterRevision: text,
  authorizationSnapshotId: z.string().regex(/^selected-auth:[a-f0-9]{64}(?![\s\S])/) }).strict();
export function parseCheckpointAuthority(value: unknown): CheckpointAuthority {
  const parsed = authoritySchema.safeParse(value);
  if (!parsed.success) throw new CheckpointRefused("authority");
  return parsed.data;
}
export interface RosterFacts {
  organizationId: string; source: string | null; nodeId: string; principalId: string; ownerPrincipalId: string;
  occupancyEpoch: number; profileKey: string | null; nodeStatus: string; lastSeenAt: Date | null;
}
/** Whether the freshly read facts are exactly the profile's pins. Exported for tests. */
export function factsMatchProfile(facts: RosterFacts, profile: CheckpointProfile, now: number): boolean {
  return isControlPairEnforced() && facts.source === "org-plane" &&
    facts.organizationId === profile.organizationId && facts.nodeId === profile.target.node_id &&
    facts.principalId === profile.occupantPrincipalId && facts.ownerPrincipalId === profile.ownerPrincipalId &&
    facts.occupancyEpoch === profile.occupancyEpoch && normalizeRosterProfileKey(facts.profileKey) === profile.profileKey &&
    facts.nodeStatus === "online" && connectionManager.isOnline(facts.nodeId) && facts.lastSeenAt !== null &&
    now - facts.lastSeenAt.getTime() >= 0 && now - facts.lastSeenAt.getTime() <= 45_000;
}
async function currentFacts(profile: CheckpointProfile, exec: DbExecutor) {
  const target = profile.target;
  const [facts] = await exec.select({
    tenantId: tenants.id, organizationId: tenants.externalId, source: tenants.externalSource,
    stationId: stations.id, principalId: stations.principalId, ownerPrincipalId: stations.userId,
    occupancyEpoch: stations.occupancyEpoch, nodeId: nodes.id, nodeStatus: nodes.status,
    lastSeenAt: nodes.lastSeenAt, profileKey: bridgeAgents.profileKey, agentKey: bridgeAgents.key,
    rosterRevision: bridgeAgents.updatedAt,
  }).from(stations)
    .innerJoin(tenants, eq(tenants.id, stations.tenantId))
    .innerJoin(nodes, and(eq(nodes.id, stations.nodeId), eq(nodes.tenantId, stations.tenantId)))
    .innerJoin(bridgeAgents, and(eq(bridgeAgents.stationId, stations.id), eq(bridgeAgents.tenantId, stations.tenantId)))
    .where(and(eq(stations.id, target.station_id), eq(stations.tenantId, target.tenant_id),
      eq(bridgeAgents.key, profile.agentKey), eq(bridgeAgents.boardId, target.board_id), eq(bridgeAgents.enabled, true)));
  if (!facts || !factsMatchProfile(facts, profile, Date.now()))
    throw new CheckpointRefused("authority");
  return { organizationId: profile.organizationId, tenantId: facts.tenantId, sourceTenantId: profile.sourceTenantId,
    stationId: facts.stationId, nodeId: facts.nodeId, principalId: profile.occupantPrincipalId,
    ownerPrincipalId: profile.ownerPrincipalId, occupancyEpoch: facts.occupancyEpoch,
    agentKey: facts.agentKey, profileKey: profile.profileKey, rosterRevision: facts.rosterRevision.toISOString() };
}

/** Reads actual tenant/roster/occupancy and issuer grants again after every awaited boundary.
 * This selection is not source certification or a capability. The caller must re-run it before each effect.
 */
export async function readCheckpointAuthority(profile: CheckpointProfile, exec: DbExecutor = db): Promise<CheckpointAuthority> {
  const before = await currentFacts(profile, exec);
  const [occupant, owner] = await Promise.all([
    orgPlaneClient().getPrincipal(profile.occupantPrincipalId), orgPlaneClient().getPrincipal(profile.ownerPrincipalId),
  ]);
  if (!occupant || occupant.id !== profile.occupantPrincipalId || occupant.kind !== "agent" || occupant.suspended || occupant.organizationId !== profile.organizationId ||
    !owner || owner.id !== profile.ownerPrincipalId || owner.suspended || owner.organizationId !== profile.organizationId ||
    !grantAllowsPrincipal(owner.grant, occupant.id)) throw new CheckpointRefused("authority");
  const after = await currentFacts(profile, exec);
  if (canonicalCheckpoint(before) !== canonicalCheckpoint(after)) throw new CheckpointRefused("stale");
  const snapshot = { ...after, ownerKind: owner.kind, ownerGrant: {
    mayDispatch: [...(owner.grant?.mayDispatch ?? [])].toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0), mayGrantReach: owner.grant?.mayGrantReach ?? false,
    scopes: [...(owner.grant?.scopes ?? [])].toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0),
  } };
  return Object.freeze({ ...after, authorizationSnapshotId: "selected-auth:" + createHash("sha256").update(canonicalCheckpoint(snapshot)).digest("hex") });
}
