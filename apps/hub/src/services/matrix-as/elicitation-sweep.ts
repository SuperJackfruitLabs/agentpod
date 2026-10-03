/**
 * The floor beneath push, for an agent's questions.
 *
 * A delivery is retried five times and then dead-lettered, at which point a card is
 * blocked on an answer nobody was told about and neither side is looking. That is the
 * half `gate-sweep.ts` already has, and this is its mirror.
 *
 * **The other half matters more here than it does for gates.** A gate stops being
 * pending only by being decided. A question is also retired the moment the same agent
 * asks the next one — the board does that itself — so a room can hold a card for a
 * question nobody can answer any more. A stale question that still looks answerable is
 * one that will be answered, by somebody who then watches nothing happen.
 *
 * Absence from the board's pending list is the signal for both halves, which is why
 * failing to read a board can never be treated as "nothing is pending": that would
 * settle every open question on a timeout.
 */
import { createLogger } from "../../utils/logger";
import type { ElicitationPendingDelivery } from "./elicitation-card";
import type { ElicitationProjectionOutcome } from "./elicitations";

const log = createLogger("elicitation-sweep");

export interface ElicitationSweepDeps {
  /** The boards this hub works, from the bridge's own configuration. */
  boards(): Promise<string[]>;
  /**
   * Which fleet a board's questions belong to, or null when this hub never worked it
   * — in which case no card on it was ever dispatched to a station, so no question on
   * it can have a room.
   */
  tenantIdFor(boardId: string): Promise<string | null>;
  /** What the board is still waiting on, read with the bridge's own token. */
  pendingElicitations(boardId: string): Promise<ElicitationPendingDelivery[]>;
  /** Post the question, exactly once. Idempotent on `elicitation_id`. */
  project(tenantId: string, d: ElicitationPendingDelivery): Promise<ElicitationProjectionOutcome>;
  /** Questions this hub put in a room and has not yet said anything final about. */
  postedAwaitingOutcome(boardId: string): Promise<Array<{ elicitationId: string; roomId: string }>>;
  /** Say in the room that it is over, and claim it so two sweeps leave one line. */
  settle(elicitationId: string, roomId: string): Promise<boolean>;
}

export interface ElicitationSweepResult {
  /** Questions this pass actually put in a room. */
  projected: number;
  /**
   * Questions that could not be put anywhere.
   *
   * Counted rather than logged and forgotten: a person is waiting on a question that
   * is in no room, and this is the only thing looking.
   */
  stuck: number;
  /** Room cards closed for questions that are over. */
  settled: number;
  /** Boards that did not answer. Their questions are NOT therefore closed. */
  boardsUnread: number;
}

/**
 * `already` is the ordinary healthy answer on a sweep pass — push got there first —
 * and counting it as a delivery would make every pass look busy. Everything that is
 * not a delivery and not `already` is a question nobody can see.
 */
function countsAsStuck(status: ElicitationProjectionOutcome["status"]): boolean {
  return status !== "posted" && status !== "already";
}

export async function sweepElicitations(deps: ElicitationSweepDeps): Promise<ElicitationSweepResult> {
  const result: ElicitationSweepResult = { projected: 0, stuck: 0, settled: 0, boardsUnread: 0 };

  for (const boardId of await deps.boards()) {
    const tenantId = await deps.tenantIdFor(boardId);
    if (!tenantId) continue;

    let pending: ElicitationPendingDelivery[];
    try {
      pending = await deps.pendingElicitations(boardId);
    } catch (err) {
      // One unreachable board must not cost every other board its sweep — and must
      // not look like a board with nothing pending, which is the shape that would
      // settle every open question on it.
      result.boardsUnread += 1;
      log.warn("board's pending questions could not be read", {
        boardId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const d of pending) {
      try {
        const outcome = await deps.project(tenantId, d);
        if (outcome.status === "posted") result.projected += 1;
        else if (countsAsStuck(outcome.status)) {
          result.stuck += 1;
          log.warn("question could not be put in a room", {
            elicitationId: d.elicitationId,
            boardId,
            status: outcome.status,
          });
        }
      } catch (err) {
        // A throw is the absence of a decision, not a decision — but for this tally
        // it means the same thing a `no-room` does: nobody can see the question.
        result.stuck += 1;
        log.warn("projecting a question threw", {
          elicitationId: d.elicitationId,
          boardId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Only now, with a list the board actually answered with.
    const open = new Set(pending.map((p) => p.elicitationId));
    for (const posted of await deps.postedAwaitingOutcome(boardId)) {
      if (open.has(posted.elicitationId)) continue;
      try {
        if (await deps.settle(posted.elicitationId, posted.roomId)) result.settled += 1;
      } catch (err) {
        log.warn("could not settle a question that is over", {
          elicitationId: posted.elicitationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}
