/** Durable once-only preparation intent. Pending rows never authorize a fresh attempt. */
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseBenchCoordinatorRequest, type BenchCoordinatorRequest } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { checkpointDispatches, type CheckpointDispatchRow } from "../../db/schema/checkpoint-dispatch";
import { parsePendingCheckpointClaim, type PendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint, parseCheckpointJSON } from "./checkpoint-json";
import { CheckpointRefused, parseCheckpointProfile, requireCheckpointProfileClaim, type CheckpointProfile } from "./checkpoint-profile";
import { parseCheckpointAuthority, readCheckpointAuthority, type CheckpointAuthority } from "./checkpoint-current";

export type PrepareRequest = Extract<BenchCoordinatorRequest, { operation: "prepare" }>;
export interface RetainedCheckpointAttempt {
  row: CheckpointDispatchRow;
  profile: CheckpointProfile;
  claim: PendingCheckpointClaim;
  request: PrepareRequest;
}
const encode = (raw: string) => new TextEncoder().encode(raw);
const hash = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

function checked(row: CheckpointDispatchRow): RetainedCheckpointAttempt {
  const profile = parseCheckpointProfile(parseCheckpointJSON(encode(row.profile)));
  const claim = parsePendingCheckpointClaim(parseCheckpointJSON(encode(row.claim)));
  const request = parseBenchCoordinatorRequest(encode(row.prepareRequest));
  const authority = parseCheckpointAuthority(parseCheckpointJSON(encode(row.authority)));
  requireCheckpointProfileClaim(profile, claim);
  if (request.operation !== "prepare" || hash(row.prepareRequest) !== row.prepareSHA256 ||
    row.tenantId !== profile.target.tenant_id || row.boardId !== claim.boardId || row.runId !== claim.runId ||
    row.leaseEpoch !== claim.leaseEpoch || row.attemptId !== request.identity.attempt_id ||
    request.identity.tenant_id !== row.tenantId || request.identity.board_id !== row.boardId ||
    request.identity.run_id !== row.runId || request.identity.epoch !== row.leaseEpoch ||
    request.identity.card_id !== claim.cardId || request.identity.stage_id !== claim.stageKey ||
    request.identity.agent_id !== claim.agentId || request.identity.policy_sha256 !== claim.policyDigest ||
    request.identity.control_principal_id !== profile.ownerPrincipalId ||
    request.identity.control_grant_id !== authority.authorizationSnapshotId || authority.tenantId !== row.tenantId ||
    authority.sourceTenantId !== profile.sourceTenantId || authority.organizationId !== profile.organizationId ||
    authority.principalId !== profile.occupantPrincipalId || authority.ownerPrincipalId !== profile.ownerPrincipalId ||
    authority.stationId !== profile.target.station_id || authority.nodeId !== profile.target.node_id ||
    authority.occupancyEpoch !== profile.occupancyEpoch || authority.agentKey !== profile.agentKey || authority.profileKey !== profile.profileKey ||
    request.task.profile_id !== profile.profileKey || canonicalCheckpoint(request.target) !== canonicalCheckpoint(profile.target))
    throw new CheckpointRefused("source");
  // The raw authority bytes are retained, not trusted as a new grant. Every
  // current check compares them to a fresh actual database/issuer observation.
  return { row, profile, claim, request };
}

export async function readCheckpointAttempt(tenantId: string, attemptId: string): Promise<RetainedCheckpointAttempt | undefined> {
  const [row] = await db.select().from(checkpointDispatches).where(and(
    eq(checkpointDispatches.tenantId, tenantId), eq(checkpointDispatches.attemptId, attemptId)));
  return row ? checked(row) : undefined;
}

function sameReservation(retained: RetainedCheckpointAttempt, profile: CheckpointProfile, claim: PendingCheckpointClaim,
  authority: CheckpointAuthority, task: PrepareRequest["task"]): void {
  if (retained.row.profile !== canonicalCheckpoint(profile) || retained.row.claim !== canonicalCheckpoint(claim) ||
    retained.row.authority !== canonicalCheckpoint(authority) ||
    canonicalCheckpoint(retained.request.task) !== canonicalCheckpoint(task)) throw new CheckpointRefused("stale");
}

/** Only send=true permits the first Prepare call. A commit with a lost reply
 * leaves a pending row: recovery reads exact Status, never creates another ID.
 */
export async function reserveCheckpointAttempt(value: CheckpointProfile, pending: PendingCheckpointClaim,
  input: PrepareRequest["task"]): Promise<{ attempt: RetainedCheckpointAttempt; send: boolean }> {
  const profile = parseCheckpointProfile(value);
  const claim = parsePendingCheckpointClaim(pending);
  requireCheckpointProfileClaim(profile, claim);
  const authority = await readCheckpointAuthority(profile);
  const existing = await db.select().from(checkpointDispatches).where(and(
    eq(checkpointDispatches.tenantId, profile.target.tenant_id), eq(checkpointDispatches.boardId, claim.boardId),
    eq(checkpointDispatches.runId, claim.runId), eq(checkpointDispatches.leaseEpoch, claim.leaseEpoch)));
  if (existing[0]) {
    const attempt = checked(existing[0]);
    sameReservation(attempt, profile, claim, authority, input);
    return { attempt, send: false };
  }
  const attemptId = "attempt_" + randomBytes(16).toString("hex");
  const parsed = parseBenchCoordinatorRequest(encode(JSON.stringify({ version: "agentpod.bench-coordinator.v1",
    operation: "prepare", target: profile.target, identity: {
      tenant_id: profile.target.tenant_id, board_id: claim.boardId, card_id: claim.cardId, stage_id: claim.stageKey,
      run_id: claim.runId, epoch: claim.leaseEpoch, agent_id: claim.agentId, station_id: profile.target.station_id,
      node_id: profile.target.node_id, attempt_id: attemptId, control_principal_id: profile.ownerPrincipalId,
      control_grant_id: authority.authorizationSnapshotId, policy_sha256: claim.policyDigest,
    }, task: input })));
  if (parsed.operation !== "prepare" || parsed.task.profile_id !== profile.profileKey) throw new CheckpointRefused("invalid");
  const request = JSON.stringify(parsed);
  const inserted = await db.insert(checkpointDispatches).values({ tenantId: profile.target.tenant_id, boardId: claim.boardId,
    runId: claim.runId, leaseEpoch: claim.leaseEpoch, attemptId, profile: canonicalCheckpoint(profile),
    claim: canonicalCheckpoint(claim), authority: canonicalCheckpoint(authority), prepareRequest: request,
    prepareSHA256: hash(request), phase: "prepare_pending" }).onConflictDoNothing().returning();
  if (inserted[0]) return { attempt: checked(inserted[0]), send: true };
  const [raced] = await db.select().from(checkpointDispatches).where(and(
    eq(checkpointDispatches.tenantId, profile.target.tenant_id), eq(checkpointDispatches.boardId, claim.boardId),
    eq(checkpointDispatches.runId, claim.runId), eq(checkpointDispatches.leaseEpoch, claim.leaseEpoch)));
  if (!raced) throw new CheckpointRefused("uncertain");
  const attempt = checked(raced);
  sameReservation(attempt, profile, claim, authority, input);
  return { attempt, send: false };
}
