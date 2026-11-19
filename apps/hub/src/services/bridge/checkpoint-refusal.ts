/**
 * What a node's `refused` reply means for the attempt, by code and by the phase that asked.
 *
 * The node's registered launch (apps/node-agent/internal/benchlaunch, docs/BENCH_REGISTERED_LAUNCH.md)
 * answers a closed set of codes. Some come only from a record it has journaled as terminal, after
 * it released what the record held: that attempt can never complete, so parking it held the card
 * `working` on heartbeats forever. Others are said about the moment (a current check the node
 * could not get, an internal error) and can turn into a completion on a later status read.
 *
 * - `failed`: the node's record is terminal and the work itself was refused. The run is settled on
 *   SuperPipeline as failed, with the reason.
 * - `released`: the node's record is terminal, nothing ran, and the refusal is about capacity or
 *   another holder, not the work. The card is handed back for a new claim.
 * - parked (no ruling): the code does not prove the record is terminal, or what it ran. It stays on
 *   its phase and is read again, as before. `stale_owner` is resolved only by the superseded-attempt
 *   path (checkpoint-supersede.ts), never here: the node also answers it when its own current check
 *   could not reach the Hub.
 *
 * Neither ruling ever reports a pass: a failure settles nothing as complete. The table is the whole
 * ruling; a code or phase it does not name parks.
 */
import type { BenchCoordinatorResponse } from "@agentpod/contract";
import type { CheckpointFailureDisposition } from "./checkpoint-ledger";

type RefusalCode = Extract<BenchCoordinatorResponse, { state: "refused"; code: string }>["code"];
type NodePhase = "prepare_pending" | "execute_pending";

/** Why each code is ruled as it is. Exported so tests and the doc read the same table. */
export const CHECKPOINT_REFUSAL_RULINGS: Readonly<Record<RefusalCode, Readonly<Record<NodePhase, CheckpointFailureDisposition | "parked">>>> = {
  // A worker crash, a result or receipt that did not verify, or a producer reply that did not parse.
  // Journaled terminal; the lease is released. Before execute nothing ran; after it the run replied.
  verification_failed: { prepare_pending: "failed", execute_pending: "failed" },
  // The producer refused the request (invalid_request / not_found): nothing ran, and the same request
  // would be refused again.
  unsupported: { prepare_pending: "failed", execute_pending: "failed" },
  // SuperBench refused create, lease or run for capacity: journaled terminal, nothing ran.
  capacity_exhausted: { prepare_pending: "released", execute_pending: "released" },
  // Before execute: another holder owns the bench, or another record is active on it. Nothing of this
  // attempt ran (no execute was ever sent). After execute it can only be a journal step that does not
  // match its own bytes, which proves nothing about the run: parked.
  conflict: { prepare_pending: "released", execute_pending: "parked" },
  // Also what the node answers when its current check fails for any reason: not proof. Superseded
  // attempts are retired with evidence by checkpoint-supersede.ts.
  stale_owner: { prepare_pending: "parked", execute_pending: "parked" },
  // The node's catch-all for an internal error, a registry it cannot load or a current check refused.
  unavailable: { prepare_pending: "parked", execute_pending: "parked" },
  // In the contract, never sent by the node's coordinator: parked rather than guessed at.
  invalid: { prepare_pending: "parked", execute_pending: "parked" },
  unauthorized: { prepare_pending: "parked", execute_pending: "parked" },
  pending: { prepare_pending: "parked", execute_pending: "parked" },
};

export interface CheckpointRefusalRuling {
  code: RefusalCode;
  disposition: CheckpointFailureDisposition;
  /** One sentence for the card and the run's failure reason. Names the code; never an identifier. */
  reason: string;
}

const where = (phase: NodePhase) => phase === "prepare_pending" ? "while preparing the bench" : "after the run";
function sentence(code: RefusalCode, phase: NodePhase): string {
  switch (code) {
    case "verification_failed": return phase === "execute_pending"
      ? "Checkpoint failed: the bench run did not verify (verification_failed): the worker crashed, or its result or receipt did not check out. Nothing was reported as a pass."
      : "Checkpoint failed: the bench could not be prepared (verification_failed). Nothing ran.";
    case "unsupported": return `Checkpoint failed: the bench refused the request as unsupported ${where(phase)}. Nothing ran.`;
    case "capacity_exhausted": return "Checkpoint released: SuperBench capacity is exhausted. Nothing ran; the card is free for a new claim.";
    case "conflict": return "Checkpoint released: another attempt holds the bench (conflict). Nothing ran; the card is free for a new claim.";
    default: return `Checkpoint refused (${code}).`;
  }
}

/** The ruling for a node reply in a phase that asked the node, or undefined when it stays parked. */
export function classifyCheckpointRefusal(phase: string, response: BenchCoordinatorResponse): CheckpointRefusalRuling | undefined {
  if (response.state !== "refused" || !("code" in response)) return undefined;
  if (phase !== "prepare_pending" && phase !== "execute_pending") return undefined;
  const code = response.code;
  const disposition = CHECKPOINT_REFUSAL_RULINGS[code]?.[phase];
  if (disposition === undefined || disposition === "parked") return undefined;
  return { code, disposition, reason: sentence(code, phase) };
}
