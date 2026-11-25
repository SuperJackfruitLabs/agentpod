/**
 * Resolving an attempt whose profile has since been replaced (a node build or pin change).
 *
 * The ledger never lets a changed profile make an unresolved reservation disappear. What it may
 * do is END one, as `retired`, when the evidence proves nothing it started is still outstanding:
 *
 * - Only before any producer effect: the phase is `prepare_pending` or `prepared`, so no source
 *   was ever admitted to SuperPipeline and no run was launched (launch needs an admitted source).
 * - And only on the node's own word, read with `status` for the attempt's exact retained identity:
 *   - `unknown` while `prepare_pending`: the node never journaled the prepare, so it did nothing.
 *   - `refused` / `stale_owner`: the node retired its own record, which it does only after
 *     releasing what the record held (BENCH_REGISTERED_LAUNCH.md, "Stale attempts clean up after
 *     themselves"). The Hub's current-decision answers `stale_owner` for a superseded profile, so
 *     this status read is also what asks the node to retire.
 * - Anything else stays parked, named, for an owner or admin to settle explicitly.
 *
 * Status is read-only on the wire; it is the one request this path sends to the bench host's node.
 *
 * A remote bench stage's attempt can never be driven again either, so its agent stops first: `detach`
 * ends the agent's session and detaches its station whatever the resolution (a failed detach is
 * named and left to the sweep). Its run is then reclaimed by the board and ended as any other.
 */
import { BENCH_COORDINATOR_VERB, BenchCoordinatorRequest, parseBenchCoordinatorResponse, type BenchCoordinatorResponse } from "@agentpod/contract";
import { request as nodeRequest } from "../broker";
import { errorFacts, noteCheckpoint, type ErrorFacts } from "./checkpoint-log";
import { endRemoteWork } from "./checkpoint-remote";
import { nodeCallTimeoutMs } from "./checkpoint-node-call";
import { NO_PRODUCER_EFFECT_PHASES, retireCheckpointAttempt, type CheckpointRetirementReason,
  type RetainedCheckpointAttempt } from "./checkpoint-ledger";

/** Why a superseded attempt stays parked. Closed, safe to log. */
export type SupersededParkReason =
  | "superseded.effect_possible"
  | "superseded.node_unreachable"
  | "superseded.node_raced"
  | `superseded.node:${string}`;

export type SupersededResolution =
  | { outcome: "retired"; reason: CheckpointRetirementReason }
  | { outcome: "parked"; reason: SupersededParkReason; error?: ErrorFacts };

/** What a status reply says, as far as resolving is concerned. */
export interface NodeStatusSummary {
  state: string;
  code?: string;
  /** The node's exact reply, kept as the retirement's evidence. */
  evidence?: string;
}

/** The attempt as this path reads it: its phase. Generic so tests need no ledger row. */
interface Phased { row: { phase: string; tenantId?: string; attemptId?: string } }

export interface SupersedeDeps<A extends Phased = RetainedCheckpointAttempt> {
  status(attempt: A): Promise<NodeStatusSummary>;
  retire(attempt: A, retirement: { reason: CheckpointRetirementReason; by: string; evidence: string }): Promise<boolean>;
  /** End a remote attempt's agent work: its session and its station's attachment (checkpoint-remote.ts `endRemoteWork`). */
  detach?(attempt: A): Promise<unknown>;
}

/** The node's status for the attempt's exact retained identity and target. Never prepare, never execute. */
async function nodeStatus(attempt: RetainedCheckpointAttempt): Promise<NodeStatusSummary> {
  const reply = await nodeStatusReply(attempt);
  const summary: NodeStatusSummary = { state: reply.state, evidence: JSON.stringify(reply) };
  if ("code" in reply) summary.code = reply.code;
  return summary;
}
async function nodeStatusReply(attempt: RetainedCheckpointAttempt): Promise<BenchCoordinatorResponse> {
  const sent = BenchCoordinatorRequest.parse({ version: attempt.request.version, operation: "status",
    identity: attempt.request.identity, target: attempt.request.target });
  const reply = await nodeRequest(attempt.request.target.node_id, BENCH_COORDINATOR_VERB, sent, { timeoutMs: nodeCallTimeoutMs("status") });
  if (!reply.ok) throw new Error(`status unavailable: ${reply.error ?? "no error"}`);
  const raw = JSON.stringify(reply.data);
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 262144) throw new Error("status invalid");
  return parseBenchCoordinatorResponse(new TextEncoder().encode(raw), sent);
}

const SUPERSEDED = "The bench stage's profile was replaced.";
/** The real effects. A caller with the station's ACP port passes its own `detach`, which also ends a session a restart left. */
export const defaultSupersedeDeps: SupersedeDeps = { status: nodeStatus, retire: retireCheckpointAttempt,
  detach: (attempt) => endRemoteWork(attempt, { request: nodeRequest }, SUPERSEDED) };
const defaults = defaultSupersedeDeps;

/** Which node reply proves nothing is outstanding, for this phase. Exported for tests. */
export function provenEffectFree(phase: string, reply: NodeStatusSummary): CheckpointRetirementReason | undefined {
  if (!NO_PRODUCER_EFFECT_PHASES.has(phase)) return undefined;
  if (reply.state === "refused" && reply.code === "stale_owner") return "superseded.node_retired";
  // A prepared attempt that the node no longer knows may still hold a lease: not proof.
  if (reply.state === "unknown" && phase === "prepare_pending") return "superseded.no_record";
  return undefined;
}

export function resolveSupersededAttempt(attempt: RetainedCheckpointAttempt): Promise<SupersededResolution>;
export function resolveSupersededAttempt<A extends Phased>(attempt: A, deps: SupersedeDeps<A>): Promise<SupersededResolution>;
export async function resolveSupersededAttempt(attempt: Phased,
  deps: SupersedeDeps<Phased> = defaults): Promise<SupersededResolution> {
  if (deps.detach) await deps.detach(attempt).catch((error: unknown) => noteCheckpoint("superseded", "remote.detach",
    { tenantId: attempt.row.tenantId, attemptId: attempt.row.attemptId, phase: attempt.row.phase }, error));
  if (!NO_PRODUCER_EFFECT_PHASES.has(attempt.row.phase)) return { outcome: "parked", reason: "superseded.effect_possible" };
  let reply: NodeStatusSummary;
  try { reply = await deps.status(attempt); }
  catch (error) { return { outcome: "parked", reason: "superseded.node_unreachable", error: errorFacts(error) }; }
  const reason = provenEffectFree(attempt.row.phase, reply);
  if (!reason) return { outcome: "parked", reason: `superseded.node:${reply.state}${reply.code === undefined ? "" : "." + reply.code}` };
  const retired = await deps.retire(attempt, { reason, by: "hub", evidence: reply.evidence ?? JSON.stringify(reply) });
  return retired ? { outcome: "retired", reason } : { outcome: "parked", reason: "superseded.node_raced" };
}
