/**
 * What a checkpoint card shows on SuperPipeline's live stream while the bench works.
 *
 * The checkpoint path ran for minutes with nothing on the card. Each phase it commits now posts one
 * short activity through the same run verb ordinary dispatch uses (`client.activity`).
 *
 * - **Never part of the checkpoint's state.** An activity is posted after the phase it describes is
 *   committed, and a failure is logged and dropped: the ledger, the node and the settlement never
 *   wait on it, retry it or read it back.
 * - **Idempotent.** A phase is posted only by the pass whose compare-and-set committed it, so a
 *   restart, a lost race or a recovery pass does not post it again; within the process each
 *   attempt's event key is posted once.
 * - **Rate-limited.** A park is re-checked on every backoff; its activity is posted once per
 *   attempt, phase and reason, never once per re-check.
 */
import type { BenchCoordinatorCompletion } from "@agentpod/contract";
import type { BoardActivity } from "./coalesce";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import type { SuperpipelineClient } from "./superpipeline";
import { noteCheckpoint } from "./checkpoint-log";

export type CheckpointActivityEvent = "prepared" | "running" | "completed" | "pushed" | "submitting" | "parked" | "failed" | "released"
  | "lease_held";

/**
 * The supported way to free a bench whose release SuperBench refused (SuperBench's leases and
 * `bench workspace` reference): an operator stop returns the retained token, a root run with it fixes
 * the tree and checkpoints (a successful run checkpoints and releases by default), then the lease is
 * released if it is still held, and the bench may be reclaimed. Nothing in the Hub or node does this:
 * the node never checkpoints interrupted work to make a release succeed.
 */
export const HELD_LEASE_OPERATOR_PATH = "`bench workspace stop_admin <key>`, then a root `bench workspace run --holder <holder> <key> -- <fix>` " +
  "with the returned token (BENCH_LEASE_TOKEN) that commits or removes the stray files and checkpoints, then `bench workspace release` " +
  "if `status` still shows the lease, and optionally `bench workspace reclaim <key>`";

/** The activity for an event, or undefined when there is nothing worth saying. Exported for tests. */
export function checkpointActivity(event: CheckpointActivityEvent, facts: {
  completion?: BenchCoordinatorCompletion; phase?: string; code?: string; reason?: string; benchKey?: string; message?: string;
} = {}): BoardActivity | undefined {
  const action = `checkpoint.${event}`;
  switch (event) {
    case "prepared": return { type: "action", action, body: "Checkpoint: the bench is prepared for this card." };
    case "running": return { type: "action", action, body: "Checkpoint: the task is running on the bench." };
    case "completed": return { type: "action", action, body: "Checkpoint: the bench run completed." };
    case "pushed": {
      const members = facts.completion?.service.checkpoints ?? [];
      if (members.length === 0) return undefined;
      const list = members.map((m) => `${m.name} ${m.task_ref.replace(/^refs\/heads\//, "")} @ ${m.commit}`).join(", ");
      return { type: "action", action, body: `Checkpoint pushed: ${list}.`,
        parameter: { commits: members.map((m) => ({ name: m.name, ref: m.task_ref, commit: m.commit })) } };
    }
    case "submitting": return { type: "action", action, body: "Checkpoint: submitting the result to the board." };
    // A definite node refusal, said before the board is told: the sentence is the run's failure reason.
    case "failed":
    case "released":
      return { type: "action", action, body: facts.reason ?? `Checkpoint ${event} (${facts.code ?? "refused"}).`,
        parameter: { phase: facts.phase, code: facts.code } };
    // SuperBench refused to release the card's bench lease (a dirty tree, for one). The node keeps
    // retrying, but the refusal does not clear itself: an operator must reconcile the bench.
    case "lease_held": {
      const bench = facts.benchKey ? `bench ${facts.benchKey}` : "this card's bench";
      const said = facts.message ? ` ("${facts.message}")` : "";
      return { type: "action", action: "checkpoint.parked",
        body: `Checkpoint: ${bench} still holds this card's lease; SuperBench refused its release${said}. Operator action needed: ${HELD_LEASE_OPERATOR_PATH}.`,
        parameter: { phase: facts.phase, code: "lease_held", ...(facts.benchKey ? { benchKey: facts.benchKey } : {}) } };
    }
    case "parked": {
      const why = [facts.code, facts.reason].filter((part): part is string => !!part).join(", ");
      return { type: "action", action, body: `Checkpoint: waiting at ${facts.phase ?? "an unknown phase"}${why ? ` (${why})` : ""}; it is re-checked automatically.`,
        parameter: { phase: facts.phase, code: facts.code, ...(facts.reason ? { reason: facts.reason } : {}) } };
    }
  }
  return undefined;
}

const MAX_REMEMBERED = 4096;
let posted = new Set<string>();

/** Test seam: forget what was posted. */
export function resetCheckpointActivityForTests(): void { posted = new Set(); }

/**
 * Post one activity for this attempt, once per `key` within the process. Never throws and never
 * changes what the caller does next; a failure is named in the checkpoint log.
 */
export async function postCheckpointActivity(client: SuperpipelineClient, attempt: RetainedCheckpointAttempt,
  key: string, activity: BoardActivity | undefined): Promise<void> {
  if (!activity) return;
  const id = [attempt.row.tenantId, attempt.row.attemptId, key].join("\0");
  if (posted.has(id)) return;
  if (posted.size >= MAX_REMEMBERED) posted = new Set();
  posted.add(id);
  try { await client.activity(attempt.claim, activity); }
  catch (error) {
    noteCheckpoint("activity", "activity.post", { boardId: attempt.row.boardId, runId: attempt.claim.runId,
      attemptId: attempt.row.attemptId, action: activity.action }, error);
  }
}
