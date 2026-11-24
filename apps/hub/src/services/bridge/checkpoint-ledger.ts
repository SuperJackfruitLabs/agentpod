/** Durable once-only preparation intent. Pending rows never authorize a fresh attempt. */
import { createHash, randomBytes } from "node:crypto";
import { createLogger } from "../../utils/logger";
import { and, asc, eq } from "drizzle-orm";
import { parseBenchCoordinatorRequest, type BenchCoordinatorRequest } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { checkpointDispatches, type CheckpointDispatchRow } from "../../db/schema/checkpoint-dispatch";
import { parsePendingCheckpointClaim, type PendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint, parseCheckpointJSON } from "./checkpoint-json";
import { checkpointProfileId, CheckpointRefused, parseCheckpointProfile, requireCheckpointProfileClaim, type CheckpointProfile } from "./checkpoint-profile";
import { parseCheckpointAuthority, readCheckpointAuthority, type CheckpointAuthority } from "./checkpoint-current";

export type PrepareRequest = Extract<BenchCoordinatorRequest, { operation: "prepare" }>;
export interface RetainedCheckpointAttempt {
  row: CheckpointDispatchRow;
  profile: CheckpointProfile;
  claim: PendingCheckpointClaim;
  request: PrepareRequest;
}
const log = createLogger("bridge-checkpoint");
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
    request.task.profile_id !== checkpointProfileId(profile) || canonicalCheckpoint(request.target) !== canonicalCheckpoint(profile.target))
    throw new CheckpointRefused("source", "ledger.row");
  // The raw authority bytes are retained, not trusted as a new grant. Every
  // current check compares them to a fresh actual database/issuer observation.
  return { row, profile, claim, request };
}

/** A ledger row checked against everything it binds; throws `CheckpointRefused` on any mismatch. */
export const checkedCheckpointAttempt = checked;

export async function readCheckpointAttempt(tenantId: string, attemptId: string): Promise<RetainedCheckpointAttempt | undefined> {
  const [row] = await db.select().from(checkpointDispatches).where(and(
    eq(checkpointDispatches.tenantId, tenantId), eq(checkpointDispatches.attemptId, attemptId)));
  return row ? checked(row) : undefined;
}

function sameReservation(retained: RetainedCheckpointAttempt, profile: CheckpointProfile, claim: PendingCheckpointClaim,
  authority: CheckpointAuthority, task: PrepareRequest["task"]): void {
  if (retained.row.profile !== canonicalCheckpoint(profile) || retained.row.claim !== canonicalCheckpoint(claim) ||
    retained.row.authority !== canonicalCheckpoint(authority) ||
    canonicalCheckpoint(retained.request.task) !== canonicalCheckpoint(task)) throw new CheckpointRefused("stale", "ledger.reservation");
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
  if (parsed.operation !== "prepare" || parsed.task.profile_id !== checkpointProfileId(profile)) throw new CheckpointRefused("invalid", "ledger.request");
  const request = JSON.stringify(parsed);
  const inserted = await db.insert(checkpointDispatches).values({ tenantId: profile.target.tenant_id, boardId: claim.boardId,
    runId: claim.runId, leaseEpoch: claim.leaseEpoch, attemptId, profile: canonicalCheckpoint(profile),
    claim: canonicalCheckpoint(claim), authority: canonicalCheckpoint(authority), prepareRequest: request,
    prepareSHA256: hash(request), phase: "prepare_pending" }).onConflictDoNothing().returning();
  if (inserted[0]) return { attempt: checked(inserted[0]), send: true };
  const [raced] = await db.select().from(checkpointDispatches).where(and(
    eq(checkpointDispatches.tenantId, profile.target.tenant_id), eq(checkpointDispatches.boardId, claim.boardId),
    eq(checkpointDispatches.runId, claim.runId), eq(checkpointDispatches.leaseEpoch, claim.leaseEpoch)));
  if (!raced) throw new CheckpointRefused("uncertain", "ledger.raced");
  const attempt = checked(raced);
  sameReservation(attempt, profile, claim, authority, input);
  return { attempt, send: false };
}

export type CheckpointAdvance =
  | { phase: "prepared"; prepared: string }
  | { phase: "source_pending"; source: string }
  | { phase: "admitted"; sourceReceipt: string }
  | { phase: "execute_pending"; executeRequest: string; executeSHA256: string }
  | { phase: "completed"; completion: string }
  | { phase: "submission_pending"; settlementBody: string; settlementSHA256: string }
  | { phase: "reported"; settlementReceipt: string };
const predecessor = { prepared: "prepare_pending", source_pending: "prepared", admitted: "source_pending",
  execute_pending: "admitted", completed: "execute_pending", submission_pending: "completed", reported: "submission_pending" };

/** Compare-and-set owns the right to send an effect. A raced or replayed
 * transition never grants that right again; every populated cell is immutable.
 */
export async function advanceCheckpointAttempt(attempt: RetainedCheckpointAttempt, evidence: CheckpointAdvance): Promise<{
  attempt: RetainedCheckpointAttempt; send: boolean;
}> {
  if (attempt.row.phase !== predecessor[evidence.phase]) throw new CheckpointRefused("stale", "ledger.phase");
  for (const [key, value] of Object.entries(evidence)) {
    if (key !== "phase" && (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 262144))
      throw new CheckpointRefused("invalid", "ledger.size");
  }
  const [updated] = await db.update(checkpointDispatches).set({ ...evidence, updatedAt: new Date() }).where(and(
    eq(checkpointDispatches.tenantId, attempt.row.tenantId), eq(checkpointDispatches.attemptId, attempt.row.attemptId),
    eq(checkpointDispatches.prepareSHA256, attempt.row.prepareSHA256), eq(checkpointDispatches.phase, attempt.row.phase))).returning();
  if (updated) {
    const next = checked(updated);
    log.info("checkpoint attempt phase committed", { tenantId: updated.tenantId,
      boardId: updated.boardId, runId: updated.runId, attemptId: updated.attemptId, phase: updated.phase });
    return { attempt: next, send: true };
  }
  const current = await readCheckpointAttempt(attempt.row.tenantId, attempt.row.attemptId);
  if (!current || Object.entries(evidence).some(([key, value]) => Reflect.get(current.row, key) !== value))
    throw new CheckpointRefused("stale", "ledger.raced");
  return { attempt: current, send: false };
}

/** Why a retained attempt ended without a report. A closed set; the evidence is stored beside it. */
export type CheckpointRetirementReason =
  /** Superseded profile; the node, asked by status, holds no record of the attempt. */
  | "superseded.no_record"
  /** Superseded profile; the node retired its own record (a terminal `stale_owner`). */
  | "superseded.node_retired"
  /** An owner or admin settled it explicitly, with their own evidence. */
  | "operator"
  /**
   * The board definitively ended the run before execute was sent (or after the node's run already
   * finished, in `completed`): nothing is running. The node was told to retire its record.
   */
  | "run_ended"
  /** The board ended the run after execute was sent, and the node's record is terminal: it stopped and released. */
  | "run_ended.stopped"
  /**
   * The board ended the run after execute was sent, and the node never confirmed it stopped within
   * the task's own timeout and a grace period, so nothing of the run can still be executing.
   */
  | "run_ended.unconfirmed"
  /** The board ended the run while a settlement was pending, and the board holds no receipt for it. */
  | "run_ended.unsettled";
export interface CheckpointRetirement {
  version: "agentpod.checkpoint-retirement.v1";
  reason: CheckpointRetirementReason;
  /** The phase the attempt was in when it was retired. */
  phase: string;
  /** "hub" for a reconciliation the ledger proved; the operator's principal for an explicit settlement. */
  by: string;
  at: string;
  /** The node's exact status reply, or the operator's statement. */
  evidence: string;
}

/** Phases in which no SuperPipeline-side effect can exist yet: no source was admitted. */
export const NO_PRODUCER_EFFECT_PHASES: ReadonlySet<string> = new Set(["prepare_pending", "prepared"]);
/** Phases that end an attempt. None blocks a new one. */
export const CHECKPOINT_TERMINAL_PHASES: ReadonlySet<string> = new Set(["reported", "retired", "failed"]);

/**
 * End an unreported attempt as `retired`, with the evidence. Compare-and-set on the phase it was
 * read in: a row that moved on meanwhile is not retired. The row and its evidence stay; nothing is
 * deleted, and the trigger refuses retiring a reported row or changing a retirement.
 */
export async function retireCheckpointAttempt(attempt: RetainedCheckpointAttempt,
  retirement: Omit<CheckpointRetirement, "version" | "phase" | "at">): Promise<boolean> {
  if (CHECKPOINT_TERMINAL_PHASES.has(attempt.row.phase)) return false;
  const body: CheckpointRetirement = { version: "agentpod.checkpoint-retirement.v1", ...retirement,
    phase: attempt.row.phase, at: new Date().toISOString() };
  const value = canonicalCheckpoint(body);
  if (Buffer.byteLength(value, "utf8") > 262144) throw new CheckpointRefused("invalid", "ledger.size");
  const [updated] = await db.update(checkpointDispatches).set({ phase: "retired", retirement: value, updatedAt: new Date() })
    .where(and(eq(checkpointDispatches.tenantId, attempt.row.tenantId), eq(checkpointDispatches.attemptId, attempt.row.attemptId),
      eq(checkpointDispatches.prepareSHA256, attempt.row.prepareSHA256), eq(checkpointDispatches.phase, attempt.row.phase))).returning();
  if (updated) log.info("checkpoint attempt retired", { tenantId: updated.tenantId, boardId: updated.boardId,
    runId: updated.runId, attemptId: updated.attemptId, from: attempt.row.phase, reason: retirement.reason });
  return Boolean(updated);
}

/** The unresolved attempts of one tenant, oldest first, for an operator to inspect. */
export async function unresolvedCheckpointAttempts(tenantId: string): Promise<CheckpointDispatchRow[]> {
  const rows = await db.select().from(checkpointDispatches).where(eq(checkpointDispatches.tenantId, tenantId))
    .orderBy(asc(checkpointDispatches.createdAt));
  return rows.filter((row) => !CHECKPOINT_TERMINAL_PHASES.has(row.phase));
}

/** The unresolved attempt on a station, and whether the installed profile has replaced the one it was made under. */
export interface PendingCheckpoint { attempt: RetainedCheckpointAttempt; superseded: boolean }

/**
 * A pending old owner blocks fresh claims; it is never relabelled as a new run. One unresolved
 * attempt per station is an invariant, not a preference: the node holds one bench per station,
 * and a newer prepare waits on the older record anyway. An attempt made under a different profile
 * is returned as `superseded`, never dropped: a changed profile cannot make an unresolved old
 * reservation disappear, only a retirement with evidence can.
 */
export async function pendingCheckpointAttempt(profile: CheckpointProfile): Promise<PendingCheckpoint | undefined> {
  const rows = await db.select().from(checkpointDispatches).where(and(
    eq(checkpointDispatches.tenantId, profile.target.tenant_id), eq(checkpointDispatches.boardId, profile.target.board_id)));
  const pending = rows.filter((row) => !CHECKPOINT_TERMINAL_PHASES.has(row.phase) && checked(row).profile.target.station_id === profile.target.station_id);
  if (pending.length > 1) throw new CheckpointRefused("uncertain", "ledger.station");
  const [row] = pending;
  return row ? { attempt: checked(row), superseded: row.profile !== canonicalCheckpoint(profile) } : undefined;
}

/** What a definite node refusal does to the attempt and its card (checkpoint-refusal.ts holds the ruling). */
export type CheckpointFailureDisposition =
  /** The run is settled on SuperPipeline as failed, with the reason: `POST …/runs/:id/fail`. */
  | "failed"
  /** Nothing ran and the refusal is about the moment, not the work: the card is handed back for a new claim. */
  | "released";
export interface CheckpointFailure {
  version: "agentpod.checkpoint-failure.v1";
  /** The node's closed refusal code, or `settlement.<why>` for a completed reply that cannot be reported. */
  code: string;
  disposition: CheckpointFailureDisposition;
  /** The sentence the card shows, and the run's failure reason. */
  reason: string;
  /** The phase the attempt was in when the node refused it. */
  phase: string;
  by: "hub";
  at: string;
  /** The node's exact reply. */
  evidence: string;
}
export interface CheckpointFailureReport {
  version: "agentpod.checkpoint-failure-report.v1";
  /**
   * `fail` or `release` were accepted; `lease_ended` means the board already ended the run (STALE_LEASE);
   * `run_ended` means the board's run view said it ended or its card moved on, so nothing was sent.
   */
  outcome: "fail" | "release" | "lease_ended" | "run_ended";
  at: string;
  /** With `run_ended`: the board's answer (checkpoint-run-ended.ts). */
  board?: { reason: string; board: Record<string, string | number | null> };
}

/** The only phases that ask the node, so the only ones a node refusal can end. */
export const NODE_REFUSABLE_PHASES: ReadonlySet<string> = new Set(["prepare_pending", "execute_pending"]);

/**
 * Hold a definite node refusal on the attempt, before anything is said to SuperPipeline:
 * compare-and-set from the phase it was read in to `failure_pending`, with the ruling and the node's
 * exact reply. A raced pass that finds the same failure already held gets it back without `send`.
 */
export async function failCheckpointAttempt(attempt: RetainedCheckpointAttempt,
  failure: Pick<CheckpointFailure, "code" | "disposition" | "reason" | "evidence">): Promise<{ attempt: RetainedCheckpointAttempt; send: boolean }> {
  if (!NODE_REFUSABLE_PHASES.has(attempt.row.phase)) throw new CheckpointRefused("stale", "ledger.phase");
  const body: CheckpointFailure = { version: "agentpod.checkpoint-failure.v1", ...failure, phase: attempt.row.phase,
    by: "hub", at: new Date().toISOString() };
  const value = canonicalCheckpoint(body);
  // The evidence is a whole node reply (at most 256 KiB, the Hub's read limit) plus the ruling around it.
  if (Buffer.byteLength(value, "utf8") > 262144 + 16384) throw new CheckpointRefused("invalid", "ledger.size");
  const [updated] = await db.update(checkpointDispatches).set({ phase: "failure_pending", failure: value, updatedAt: new Date() })
    .where(and(eq(checkpointDispatches.tenantId, attempt.row.tenantId), eq(checkpointDispatches.attemptId, attempt.row.attemptId),
      eq(checkpointDispatches.prepareSHA256, attempt.row.prepareSHA256), eq(checkpointDispatches.phase, attempt.row.phase))).returning();
  if (updated) {
    log.info("checkpoint attempt failed by the node", { tenantId: updated.tenantId, boardId: updated.boardId,
      runId: updated.runId, attemptId: updated.attemptId, from: attempt.row.phase, code: failure.code, disposition: failure.disposition });
    return { attempt: checked(updated), send: true };
  }
  const current = await readCheckpointAttempt(attempt.row.tenantId, attempt.row.attemptId);
  if (!current || (current.row.phase !== "failure_pending" && current.row.phase !== "failed")) throw new CheckpointRefused("stale", "ledger.raced");
  return { attempt: current, send: false };
}

/** End a `failure_pending` attempt as `failed`, once SuperPipeline has been told. Compare-and-set. */
export async function closeFailedCheckpointAttempt(attempt: RetainedCheckpointAttempt,
  outcome: CheckpointFailureReport["outcome"], board?: CheckpointFailureReport["board"]): Promise<{ attempt: RetainedCheckpointAttempt; send: boolean }> {
  if (attempt.row.phase !== "failure_pending") throw new CheckpointRefused("stale", "ledger.phase");
  const report: CheckpointFailureReport = { version: "agentpod.checkpoint-failure-report.v1", outcome, at: new Date().toISOString(),
    ...(board === undefined ? {} : { board }) };
  const [updated] = await db.update(checkpointDispatches).set({ phase: "failed", failureReport: canonicalCheckpoint(report), updatedAt: new Date() })
    .where(and(eq(checkpointDispatches.tenantId, attempt.row.tenantId), eq(checkpointDispatches.attemptId, attempt.row.attemptId),
      eq(checkpointDispatches.prepareSHA256, attempt.row.prepareSHA256), eq(checkpointDispatches.phase, "failure_pending"))).returning();
  if (updated) {
    log.info("checkpoint attempt ended failed", { tenantId: updated.tenantId, boardId: updated.boardId,
      runId: updated.runId, attemptId: updated.attemptId, outcome });
    return { attempt: checked(updated), send: true };
  }
  const current = await readCheckpointAttempt(attempt.row.tenantId, attempt.row.attemptId);
  if (!current || current.row.phase !== "failed") throw new CheckpointRefused("stale", "ledger.raced");
  return { attempt: current, send: false };
}
