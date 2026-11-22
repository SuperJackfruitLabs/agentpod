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
import type { BenchCoordinatorCompletion, BenchCoordinatorResponse } from "@agentpod/contract";
import type { CheckpointFailureDisposition } from "./checkpoint-ledger";
import { CheckpointRefused, type CheckpointSettlementRefusal } from "./checkpoint-profile";
import { redact } from "./checkpoint-log";

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
  /** The node's refusal code, or `settlement.<why>` for a completed reply that cannot be reported. */
  code: RefusalCode | `settlement.${CheckpointSettlementRefusal}`;
  disposition: CheckpointFailureDisposition;
  /** One sentence for the card and the run's failure reason. Names the code; never an identifier. */
  reason: string;
}

const where = (phase: NodePhase) => phase === "prepare_pending" ? "while preparing the bench" : "after the run";
function sentence(code: RefusalCode, phase: NodePhase): string {
  switch (code) {
    case "verification_failed": return phase === "execute_pending"
      ? "Checkpoint failed: the bench run did not verify (verification_failed): the worker crashed or was stopped before it finished (for example by a SuperBench restart), or its result or receipt did not check out. Nothing was reported as a pass."
      : "Checkpoint failed: the bench could not be prepared (verification_failed). Nothing ran.";
    case "unsupported": return `Checkpoint failed: the bench refused the request as unsupported ${where(phase)}. Nothing ran.`;
    case "capacity_exhausted": return "Checkpoint released: SuperBench capacity is exhausted. Nothing ran; the card is free for a new claim.";
    case "conflict": return "Checkpoint released: another attempt holds the bench (conflict). Nothing ran; the card is free for a new claim.";
    default: return `Checkpoint refused (${code}).`;
  }
}

/** At most this much of the bench's own words reaches the card and the run's failure reason. */
export const MAX_BENCH_MESSAGE = 200;

/**
 * SuperBench's refusal text as the node relayed it (`detail.message`), safe for the card: redacted
 * (checkpoint-log.ts), paths removed, whitespace collapsed and bounded. Undefined when there is none.
 * Exported for tests.
 */
export function benchMessage(response: BenchCoordinatorResponse): string | undefined {
  return detailText("detail" in response ? response.detail?.message : undefined);
}

/**
 * Why the task itself failed, as its worker said in a failed result (`detail.task`): for a model
 * provider that refused the call, its status and what it means. The same safety as `benchMessage`.
 * Exported for tests.
 */
export function taskMessage(response: BenchCoordinatorResponse): string | undefined {
  return detailText("detail" in response ? response.detail?.task : undefined);
}

function detailText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = redact(raw).replace(/(?:^|\s)\/[^\s"'`;,]+/g, " [path]").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_BENCH_MESSAGE ? `${text.slice(0, MAX_BENCH_MESSAGE - 1)}…` : text;
}

/**
 * The sentence when SuperBench said why: its own words replace the guess. A refused checkpoint or
 * release over uncommitted files used to read "the worker crashed or was stopped … (for example by a
 * SuperBench restart)", which sent the operator looking for a restart that never happened.
 */
function benchSentence(code: RefusalCode, phase: NodePhase, message: string): string | undefined {
  switch (code) {
    case "verification_failed": case "unsupported": return phase === "execute_pending"
      ? `Checkpoint failed: SuperBench refused the bench step after the run (${code}): "${message}". Nothing was reported as a pass.`
      : `Checkpoint failed: SuperBench refused while preparing the bench (${code}): "${message}". Nothing ran.`;
    case "capacity_exhausted": return `Checkpoint released: SuperBench capacity is exhausted ("${message}"). Nothing ran; the card is free for a new claim.`;
    case "conflict": return `Checkpoint released: another attempt holds the bench (conflict: "${message}"). Nothing ran; the card is free for a new claim.`;
    default: return undefined;
  }
}

/** The ruling for a node reply in a phase that asked the node, or undefined when it stays parked. */
export function classifyCheckpointRefusal(phase: string, response: BenchCoordinatorResponse): CheckpointRefusalRuling | undefined {
  if (response.state !== "refused" || !("code" in response)) return undefined;
  if (phase !== "prepare_pending" && phase !== "execute_pending") return undefined;
  const code = response.code;
  const disposition = CHECKPOINT_REFUSAL_RULINGS[code]?.[phase];
  if (disposition === undefined || disposition === "parked") return undefined;
  const message = benchMessage(response);
  // The task's own reason is the most specific: SuperBench's message for a failed run only says the
  // operation failed, which sent the operator to the bench's logs for a model key the provider refused.
  const task = phase === "execute_pending" && code === "verification_failed" ? taskMessage(response) : undefined;
  const reason = (task === undefined ? undefined : `Checkpoint failed: the task failed on the bench: "${task}". Nothing was reported as a pass.`) ??
    (message === undefined ? undefined : benchSentence(code, phase, message)) ?? sentence(code, phase);
  return { code, disposition, reason };
}

/**
 * A completed node reply whose settlement cannot be built. The build reads only the attempt's immutable
 * cells and the node's journaled completion, so every `settlement.*` refusal recurs on every pass: the
 * run finished but cannot become a pass. Each one fails the run, with a sentence that says which.
 * Anything else thrown while building (no reason, or not a settlement refusal) is not ruled and parks.
 */
export const SETTLEMENT_REFUSAL_SENTENCES: Readonly<Record<CheckpointSettlementRefusal, string>> = {
  unchanged: "Checkpoint failed: the run finished but produced no change, and this stage requires one.",
  task_outcome: "Checkpoint failed: the run finished but the task did not complete.",
  foreign_source: "Checkpoint failed: the run finished, but its result does not belong to the source this card admitted.",
  foreign_member: "Checkpoint failed: the run finished, but a pushed checkpoint is not on this card's repository or branch.",
  completion: "Checkpoint failed: the run finished, but the node's completion is not one the Hub can report.",
  retained_source: "Checkpoint failed: the run finished, but the attempt's retained prepared source does not check out.",
  shape: "Checkpoint failed: the run finished, but its result does not make a valid settlement.",
  size: "Checkpoint failed: the run finished, but its settlement is larger than the board accepts.",
};

const isSettlementRefusal = (why: string): why is CheckpointSettlementRefusal => Object.hasOwn(SETTLEMENT_REFUSAL_SENTENCES, why);

export function classifySettlementRefusal(error: unknown, completion?: BenchCoordinatorCompletion): CheckpointRefusalRuling | undefined {
  if (!(error instanceof CheckpointRefused) || !error.reason?.startsWith("settlement.")) return undefined;
  const why = error.reason.slice("settlement.".length);
  if (!isSettlementRefusal(why)) return undefined;
  const key = why;
  let reason = SETTLEMENT_REFUSAL_SENTENCES[key];
  if (key === "task_outcome" && completion) reason = reason.replace("did not complete.", `did not complete (${completion.task.outcome}).`);
  return { code: `settlement.${key}`, disposition: "failed", reason: `${reason} Nothing was reported as a pass.` };
}
