/**
 * Waiting cards on the fleet Live Activity.
 *
 * A card waiting on a person (`attention-projection.ts`) is a pending decision for each of its
 * board's humans, as a gate is (`fleet-gates.ts`). It carries no inline options: resuming needs
 * typed words, and archiving is not a Lock Screen tap — the card opens the room. It stops being a
 * decision when it is answered from the room, or when the board's waiting list — read by the gate
 * sweep — no longer has that wait; the same read brings it back after a hub restart.
 */

import { attentionDecisionKey, clearFleetDecision, fleetSink, noteFleet, type DecisionRecord } from "../push";
import { cutToBytes } from "./gate-wire";
import type { AttentionPendingDelivery } from "./attention-wire";
import type { WaitKey } from "./attention-projection";

export interface PostedAttention {
  roomId: string;
  eventId: string;
}

/** What the Lock Screen says: the card and why it waits. Bounded again by the planner. */
function question(d: AttentionPendingDelivery): string {
  const title = cutToBytes(d.cardTitle, 200);
  if (d.reason === "blocked") return `"${title}" is blocked`;
  if (d.reason === "not-authorised") return `"${title}" is not authorised to go on`;
  if (d.reason === "repeated-failure") return `"${title}" keeps failing`;
  return `"${title}" needs you`;
}

export function attentionDecisionRecord(d: AttentionPendingDelivery, posted: PostedAttention, at: number): DecisionRecord {
  const stage = typeof d.stageName === "string" && d.stageName.trim() !== "" ? d.stageName : d.stageKey;
  return {
    key: attentionDecisionKey(d),
    roomId: posted.roomId,
    eventId: posted.eventId,
    // Who is waiting: no agent asked, so the card's board and stage stand in its place.
    agent: (typeof d.boardName === "string" && d.boardName.trim() !== "" ? d.boardName : stage) || "Board",
    kind: "attention",
    question: question(d),
    options: [],
    askedAt: at,
    boardId: d.boardId,
  };
}

export async function noteAttentionPosted(
  d: AttentionPendingDelivery,
  posted: PostedAttention,
  deps: { humansFor(boardId: string): Promise<string[]>; now?: () => number },
): Promise<void> {
  if (!fleetSink()) return;
  const decision = attentionDecisionRecord(d, posted, (deps.now ?? Date.now)());
  for (const reader of await deps.humansFor(d.boardId)) noteFleet(reader, { type: "decision-asked", decision });
}

/** Answered from the room, or closed by the sweep: off the Lock Screen at once. */
export function clearAttentionDecision(k: WaitKey): void {
  clearFleetDecision(attentionDecisionKey(k));
}

/**
 * A sweep read this board's waiting cards: drop the waits it no longer lists, and show again the
 * posted ones a restarted hub forgot.
 */
export async function reconcileBoardAttention(
  boardId: string,
  waiting: AttentionPendingDelivery[],
  deps: {
    humansFor(boardId: string): Promise<string[]>;
    postedFor(k: WaitKey): Promise<PostedAttention | null>;
    now?: () => number;
  },
): Promise<void> {
  const sink = fleetSink();
  if (!sink) return;
  sink.reconcileBoardDecisions?.("attention", boardId, new Set(waiting.map((d) => attentionDecisionKey(d))));
  const forgotten = waiting.filter((d) => !sink.knowsDecision(attentionDecisionKey(d)));
  if (forgotten.length === 0) return;
  let humans: string[] | null = null;
  for (const d of forgotten) {
    const posted = await deps.postedFor(d);
    // Never posted here (or still being posted): there is no event to open yet.
    if (!posted) continue;
    humans ??= await deps.humansFor(boardId);
    const decision = attentionDecisionRecord(d, posted, (deps.now ?? Date.now)());
    for (const reader of humans) noteFleet(reader, { type: "decision-asked", decision });
  }
}
