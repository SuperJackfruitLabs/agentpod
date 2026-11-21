/**
 * Whether the board has definitively ended a checkpoint attempt's run.
 *
 * A card moved off the bench stage, cancelled by a review or a route change, deleted, reclaimed
 * after its heartbeat lapsed, or failed or released elsewhere: each ends the attempt's run on the
 * board while the Hub's attempt may still be unresolved. Parking such an attempt waits forever:
 * the run can never come back (a card is only ever bound to a NEW run id by a claim), and one
 * unresolved attempt holds the whole station's checkpoint claims.
 *
 * Only the board's own explicit answers count (bench-checkpoint-reporting.md, "When the board
 * ends the run"). A 5xx, a timeout, a body that does not parse, a run that is someone else's
 * (`NOT_RUN_OWNER`) or an answer about another run proves nothing, and the caller keeps parking.
 */
import { z } from "zod";
import type { PendingCheckpointClaim } from "./checkpoint-claim";
import { noteCheckpoint } from "./checkpoint-log";
import { SuperpipelineApiError, type SuperpipelineClient } from "./superpipeline";

/** How the board said the run ended. Closed, safe to log and to keep as evidence. */
export type RunEndedReason =
  /** GET runs/:id: the run is no longer `working` (completed, crashed, released, reclaimed, blocked, submitted). */
  | "run.ended"
  /** GET runs/:id: the run is still `working`, but its card no longer names it (moved, rejected, re-routed). */
  | "run.unbound"
  /** GET runs/:id: the run carries another lease epoch than the attempt's. */
  | "run.epoch"
  /** 404 `RUN_NOT_FOUND` / `CARD_NOT_FOUND`: the card was deleted, and its runs with it. */
  | "run.not_found" | "card.not_found"
  /** 409 `STALE_LEASE` on a run verb: no active lease for this run. */
  | "lease.stale";

export interface RunEnded {
  reason: RunEndedReason;
  /** The board's answer, closed fields only: never a body, a token or free text. */
  board: Record<string, string | number | null>;
}

const short = z.string().max(128);
const runView = z.object({
  run: z.object({ runId: short, cardId: short, leaseEpoch: z.number().int(), status: z.string().max(32),
    outcome: z.string().max(32).nullable().optional(), endedAt: z.string().max(64).nullable() }).passthrough(),
  card: z.object({ id: short, currentRunId: short.nullable(), currentStageKey: short.optional() }).passthrough(),
}).passthrough();

/**
 * The board's run view, read against the attempt's claim. Undefined unless it definitively says the
 * run ended: a view of another run or card, or one that does not parse, is not an answer. Exported for tests.
 */
export function runEndedFromView(value: unknown, claim: PendingCheckpointClaim): RunEnded | undefined {
  const parsed = runView.safeParse(value);
  if (!parsed.success) return undefined;
  const { run, card } = parsed.data;
  if (run.runId !== claim.runId || run.cardId !== claim.cardId || card.id !== claim.cardId) return undefined;
  const board = { status: run.status, outcome: run.outcome ?? null, endedAt: run.endedAt, leaseEpoch: run.leaseEpoch,
    cardRunId: card.currentRunId, cardStage: card.currentStageKey ?? null };
  if (run.leaseEpoch !== claim.leaseEpoch) return { reason: "run.epoch", board };
  if (run.status !== "working" || run.endedAt !== null) return { reason: "run.ended", board };
  if (card.currentRunId !== claim.runId) return { reason: "run.unbound", board };
  return undefined;
}

/** A board refusal that ends the run, by its exact status and code. Exported for tests. */
export function runEndedFromError(error: unknown): RunEnded | undefined {
  if (!(error instanceof SuperpipelineApiError)) return undefined;
  const board = { httpStatus: error.status, code: error.code };
  if (error.status === 409 && error.code === "STALE_LEASE") return { reason: "lease.stale", board };
  if (error.status === 404 && error.code === "RUN_NOT_FOUND") return { reason: "run.not_found", board };
  if (error.status === 404 && error.code === "CARD_NOT_FOUND") return { reason: "card.not_found", board };
  return undefined;
}

/**
 * Ask the board whether the attempt's run has ended. Read-only: a GET of the run, which neither
 * heartbeats nor touches the card. Anything but a definitive answer is undefined, named in the log.
 */
export async function readRunEnded(client: SuperpipelineClient, claim: PendingCheckpointClaim): Promise<RunEnded | undefined> {
  try {
    return runEndedFromView(await client.runRecord(claim.runId), claim);
  } catch (error) {
    const ended = runEndedFromError(error);
    if (!ended) noteCheckpoint("run-ended", "board.unanswered", { boardId: claim.boardId, runId: claim.runId }, error);
    return ended;
  }
}
