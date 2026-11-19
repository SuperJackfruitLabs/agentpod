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
 * Status is read-only on the wire; it is the one request this path sends.
 */
import { BENCH_COORDINATOR_VERB, BenchCoordinatorRequest, parseBenchCoordinatorResponse, type BenchCoordinatorResponse } from "@agentpod/contract";
import { request as nodeRequest } from "../broker";
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
  | { outcome: "parked"; reason: SupersededParkReason };

export interface SupersedeDeps {
  status(attempt: RetainedCheckpointAttempt): Promise<BenchCoordinatorResponse>;
  retire: typeof retireCheckpointAttempt;
}

/** The node's status for the attempt's exact retained identity and target. Never prepare, never execute. */
async function nodeStatus(attempt: RetainedCheckpointAttempt): Promise<BenchCoordinatorResponse> {
  const sent = BenchCoordinatorRequest.parse({ version: attempt.request.version, operation: "status",
    identity: attempt.request.identity, target: attempt.request.target });
  const reply = await nodeRequest(attempt.request.target.node_id, BENCH_COORDINATOR_VERB, sent, { timeoutMs: 15_000 });
  if (!reply.ok) throw new Error("status unavailable");
  const raw = JSON.stringify(reply.data);
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 262144) throw new Error("status invalid");
  return parseBenchCoordinatorResponse(new TextEncoder().encode(raw), sent);
}

const defaults: SupersedeDeps = { status: nodeStatus, retire: retireCheckpointAttempt };

/** Which node reply proves nothing is outstanding, for this phase. Exported for tests. */
export function provenEffectFree(phase: string, reply: BenchCoordinatorResponse): CheckpointRetirementReason | undefined {
  if (!NO_PRODUCER_EFFECT_PHASES.has(phase)) return undefined;
  if (reply.state === "refused" && "code" in reply && reply.code === "stale_owner") return "superseded.node_retired";
  // A prepared attempt that the node no longer knows may still hold a lease: not proof.
  if (reply.state === "unknown" && phase === "prepare_pending") return "superseded.no_record";
  return undefined;
}

export async function resolveSupersededAttempt(attempt: RetainedCheckpointAttempt,
  deps: SupersedeDeps = defaults): Promise<SupersededResolution> {
  if (!NO_PRODUCER_EFFECT_PHASES.has(attempt.row.phase)) return { outcome: "parked", reason: "superseded.effect_possible" };
  let reply: BenchCoordinatorResponse;
  try { reply = await deps.status(attempt); } catch { return { outcome: "parked", reason: "superseded.node_unreachable" }; }
  const reason = provenEffectFree(attempt.row.phase, reply);
  if (!reason) return { outcome: "parked", reason: `superseded.node:${reply.state}${"code" in reply ? "." + reply.code : ""}` };
  const retired = await deps.retire(attempt, { reason, by: "hub", evidence: JSON.stringify(reply) });
  return retired ? { outcome: "retired", reason } : { outcome: "parked", reason: "superseded.node_raced" };
}
