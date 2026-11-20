/** Fresh background-work authority. No workspace-admin exception and no display-directory cache. */
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db, type DbExecutor } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { tenants } from "../../db/schema/tenants";
import { nodes } from "../../db/schema/nodes";
import { bridgeAgents } from "../../db/schema/bridge";
import { orgPlaneClient, type PlanePrincipal } from "../../auth/org-plane/client";
import { grantAllowsPrincipal } from "../../auth/org-plane/grants";
import { connectionManager } from "../broker";
import { isControlPairEnforced } from "../control";
import { canonicalCheckpoint } from "./checkpoint-json";
import { CheckpointRefused, normalizeRosterProfileKey, type CheckpointProfile, type CheckpointRefusalReason } from "./checkpoint-profile";

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
  /**
   * `roster:<sha256>` over the roster row's authority-bearing fields only (rosterAuthorityRevision).
   * Attempts reserved before this was a digest hold the row's `updatedAt` instant here instead.
   */
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
  if (!parsed.success) throw new CheckpointRefused("authority", "authority.shape");
  return parsed.data;
}
/**
 * The roster row's fields that bear on a checkpoint attempt's authority: which board and station it
 * serves, whether it is enabled, its permission mode, its profile and its plane credential source.
 * Everything else on the row (concurrency, the permission wait, the pasted ordinary token, the
 * harness MCP token) is loop tuning or another path's credential: editing it rebuilds the loop, as
 * `updatedAt` makes it, but must not strand an in-flight checkpoint attempt as `authority.changed`.
 * Exported for tests.
 */
export interface RosterAuthorityFields {
  boardId: string; stationId: string; enabled: boolean; mode: string; profileKey: string | null; credentialSource: unknown;
}
const ROSTER_REVISION = /^roster:[a-f0-9]{64}(?![\s\S])/;
export function rosterAuthorityRevision(row: RosterAuthorityFields): string {
  const fields = { boardId: row.boardId, stationId: row.stationId, enabled: row.enabled, mode: row.mode,
    profileKey: row.profileKey ?? "", ...(row.credentialSource == null ? {} : { credentialSource: row.credentialSource }) };
  return "roster:" + createHash("sha256").update(canonicalCheckpoint(fields)).digest("hex");
}

export interface RosterFacts {
  organizationId: string | null; source: string | null; nodeId: string; principalId: string | null; ownerPrincipalId: string;
  occupancyEpoch: number; profileKey: string | null; nodeStatus: string; lastSeenAt: Date | null;
}
/**
 * The first pin the freshly read facts break, or undefined when they are exactly the profile's.
 * No row at all is `facts.row`: the station, tenant, node, board or enabled roster row does not join. Exported for tests.
 */
export function factsRefusal(facts: RosterFacts | undefined, profile: CheckpointProfile, now: number): CheckpointRefusalReason | undefined {
  if (!facts) return "facts.row";
  if (!isControlPairEnforced()) return "facts.enforcement";
  if (facts.source !== "org-plane") return "facts.tenant.source";
  if (facts.organizationId !== profile.organizationId) return "facts.tenant.organization";
  if (facts.nodeId !== profile.target.node_id) return "facts.node";
  if (facts.principalId !== profile.occupantPrincipalId) return "facts.principal";
  if (facts.ownerPrincipalId !== profile.ownerPrincipalId) return "facts.owner";
  if (facts.occupancyEpoch !== profile.occupancyEpoch) return "facts.epoch";
  if (normalizeRosterProfileKey(facts.profileKey) !== profile.profileKey) return "facts.profile";
  if (facts.nodeStatus !== "online") return "node.status";
  // The broker's sessions are keyed by node id (routes/gateway.ts registers the authenticated node id).
  if (!connectionManager.isOnline(facts.nodeId)) return "node.offline";
  if (facts.lastSeenAt === null || now - facts.lastSeenAt.getTime() < 0 || now - facts.lastSeenAt.getTime() > 45_000)
    return "node.last_seen";
  return undefined;
}
/** Whether the freshly read facts are exactly the profile's pins. Exported for tests. */
export function factsMatchProfile(facts: RosterFacts, profile: CheckpointProfile, now: number): boolean {
  return factsRefusal(facts, profile, now) === undefined;
}
/** The first issuer fact that breaks the profile, or undefined when both principals stand. Exported for tests. */
export function issuerRefusal(profile: CheckpointProfile, occupant: PlanePrincipal | null, owner: PlanePrincipal | null): CheckpointRefusalReason | undefined {
  if (!occupant || occupant.id !== profile.occupantPrincipalId) return "issuer.occupant.missing";
  if (occupant.kind !== "agent") return "issuer.occupant.kind";
  if (occupant.suspended) return "issuer.occupant.suspended";
  if (occupant.organizationId !== profile.organizationId) return "issuer.occupant.organization";
  if (!owner || owner.id !== profile.ownerPrincipalId) return "issuer.owner.missing";
  if (owner.suspended) return "issuer.owner.suspended";
  if (owner.organizationId !== profile.organizationId) return "issuer.owner.organization";
  if (!grantAllowsPrincipal(owner.grant, occupant.id)) return "issuer.grant";
  return undefined;
}
async function currentFacts(profile: CheckpointProfile, exec: DbExecutor) {
  const target = profile.target;
  const [facts] = await exec.select({
    tenantId: tenants.id, organizationId: tenants.externalId, source: tenants.externalSource,
    stationId: stations.id, principalId: stations.principalId, ownerPrincipalId: stations.userId,
    occupancyEpoch: stations.occupancyEpoch, nodeId: nodes.id, nodeStatus: nodes.status,
    lastSeenAt: nodes.lastSeenAt, profileKey: bridgeAgents.profileKey, agentKey: bridgeAgents.key,
    boardId: bridgeAgents.boardId, enabled: bridgeAgents.enabled, mode: bridgeAgents.mode,
    credentialSource: bridgeAgents.credentialSource,
  }).from(stations)
    .innerJoin(tenants, eq(tenants.id, stations.tenantId))
    .innerJoin(nodes, and(eq(nodes.id, stations.nodeId), eq(nodes.tenantId, stations.tenantId)))
    .innerJoin(bridgeAgents, and(eq(bridgeAgents.stationId, stations.id), eq(bridgeAgents.tenantId, stations.tenantId)))
    .where(and(eq(stations.id, target.station_id), eq(stations.tenantId, target.tenant_id),
      eq(bridgeAgents.key, profile.agentKey), eq(bridgeAgents.boardId, target.board_id), eq(bridgeAgents.enabled, true)));
  const refusal = factsRefusal(facts, profile, Date.now());
  if (refusal || !facts) throw new CheckpointRefused("authority", refusal ?? "facts.row");
  return { organizationId: profile.organizationId, tenantId: facts.tenantId, sourceTenantId: profile.sourceTenantId,
    stationId: facts.stationId, nodeId: facts.nodeId, principalId: profile.occupantPrincipalId,
    ownerPrincipalId: profile.ownerPrincipalId, occupancyEpoch: facts.occupancyEpoch,
    agentKey: facts.agentKey, profileKey: profile.profileKey, rosterRevision: rosterAuthorityRevision({ boardId: facts.boardId,
      stationId: facts.stationId, enabled: facts.enabled, mode: facts.mode, profileKey: facts.profileKey,
      credentialSource: facts.credentialSource }) };
}

/** Reads actual tenant/roster/occupancy and issuer grants again after every awaited boundary.
 * This selection is not source certification or a capability. The caller must re-run it before each effect.
 */
export async function readCheckpointAuthority(profile: CheckpointProfile, exec: DbExecutor = db): Promise<CheckpointAuthority> {
  const before = await currentFacts(profile, exec);
  const [occupant, owner] = await Promise.all([
    orgPlaneClient().getPrincipal(profile.occupantPrincipalId), orgPlaneClient().getPrincipal(profile.ownerPrincipalId),
  ]);
  const issuer = issuerRefusal(profile, occupant, owner);
  if (issuer || !owner) throw new CheckpointRefused("authority", issuer ?? "issuer.owner.missing");
  const after = await currentFacts(profile, exec);
  if (canonicalCheckpoint(before) !== canonicalCheckpoint(after)) throw new CheckpointRefused("stale", "authority.raced");
  return selectedCheckpointAuthority(after, owner);
}

/** The fresh facts and issuer owner as the selected authority, with its legacy view. Exported for tests. */
export function selectedCheckpointAuthority(after: Omit<CheckpointAuthority, "authorizationSnapshotId">,
  owner: Pick<PlanePrincipal, "kind" | "grant">): CheckpointAuthority {
  const ownerGrant = {
    mayDispatch: [...(owner.grant?.mayDispatch ?? [])].toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0), mayGrantReach: owner.grant?.mayGrantReach ?? false,
    scopes: [...(owner.grant?.scopes ?? [])].toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0),
  };
  const build = (rosterRevision: string): CheckpointAuthority => {
    const base = { ...after, rosterRevision };
    const snapshot = { ...base, ownerKind: owner.kind, ownerGrant };
    return Object.freeze({ ...base, authorizationSnapshotId: "selected-auth:" + createHash("sha256").update(canonicalCheckpoint(snapshot)).digest("hex") });
  };
  const authority = build(after.rosterRevision);
  legacyViews.set(authority, build);
  return authority;
}

/** The same fresh read, recomputed under a legacy `updatedAt` revision. Never exported, never stored. */
const legacyViews = new WeakMap<CheckpointAuthority, (rosterRevision: string) => CheckpointAuthority>();

/**
 * Whether a fresh authority read is the attempt's retained authority. Exact equality, except for an
 * attempt reserved before the roster revision was a digest: its retained `rosterRevision` is the
 * row's `updatedAt` instant, which every routine edit moved. That one field is then taken from the
 * retained value and everything else, including the authorization snapshot digest recomputed over
 * it, must still be exactly equal: station, node, occupancy epoch, principals, agent and profile
 * key, owner grant. The roster pins those reads already check (board, station, enabled row, profile)
 * still hold. Only a legacy attempt loses detection of a mode or credential-source edit.
 */
export function checkpointAuthorityMatches(fresh: CheckpointAuthority, retained: string | null | undefined): boolean {
  if (typeof retained !== "string") return false;
  if (canonicalCheckpoint(fresh) === retained) return true;
  const view = legacyViews.get(fresh);
  if (!view) return false;
  let prior: CheckpointAuthority;
  try { prior = parseCheckpointAuthority(JSON.parse(retained)); }
  catch { return false; } // silent-catch-ok: an unreadable retained authority is no match; the caller refuses it as authority.changed and says so.
  if (ROSTER_REVISION.test(prior.rosterRevision) || Number.isNaN(Date.parse(prior.rosterRevision))) return false;
  return canonicalCheckpoint(view(prior.rosterRevision)) === retained;
}
