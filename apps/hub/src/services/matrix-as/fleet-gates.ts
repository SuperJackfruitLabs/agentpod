/**
 * Superpipeline gates on the fleet Live Activity.
 *
 * A gate is posted into its board's room (`gates.ts`) and answered by a human
 * the board names; for the Lock Screen card it is a pending decision for each
 * of those humans. It stops being one when it is answered from a room
 * (`index.ts` wires `handleGateDecision`), or when the board's pending list —
 * read every five minutes by the gate sweep — no longer has it, which is how
 * an answer given on the board itself reaches the card. The same sweep is what
 * brings a still-pending gate back after a hub restart.
 */

import { fleetSink, gateDecisionKey, noteFleet } from "../push/fleet/sink";
import { inlineGateOptions, type DecisionRecord } from "../push/fleet/state";
import type { GatePendingDelivery } from "./gates";

export interface PostedGate {
  roomId: string;
  eventId: string;
  proseEventId: string | null;
}

export function gateDecisionRecord(d: GatePendingDelivery, posted: PostedGate, at: number): DecisionRecord {
  return {
    key: gateDecisionKey(d.gateId),
    roomId: posted.roomId,
    // The prose message is the one a phone was pushed, and a decision may
    // reference either event (`handleGateDecision`).
    eventId: posted.proseEventId ?? posted.eventId,
    agent: d.producedBy,
    kind: "gate",
    question: `Approve "${d.cardTitle}"?`,
    options: inlineGateOptions(d.options),
    askedAt: at,
    boardId: d.boardId,
  };
}

export async function noteGatePosted(
  d: GatePendingDelivery,
  posted: PostedGate,
  deps: { humansFor(boardId: string): Promise<string[]>; now?: () => number }
): Promise<void> {
  if (!fleetSink()) return;
  const decision = gateDecisionRecord(d, posted, (deps.now ?? Date.now)());
  for (const reader of await deps.humansFor(d.boardId)) noteFleet(reader, { type: "decision-asked", decision });
}

export async function reconcileBoardGates(
  boardId: string,
  pending: GatePendingDelivery[],
  deps: {
    humansFor(boardId: string): Promise<string[]>;
    projectionFor(gateId: string): Promise<PostedGate | null>;
    now?: () => number;
  }
): Promise<void> {
  const sink = fleetSink();
  if (!sink) return;
  sink.reconcileGates(boardId, new Set(pending.map((g) => g.gateId)));
  const forgotten = pending.filter((g) => !sink.knowsDecision(gateDecisionKey(g.gateId)));
  if (forgotten.length === 0) return;
  let humans: string[] | null = null;
  for (const g of forgotten) {
    const posted = await deps.projectionFor(g.gateId);
    // Never posted here (or still being posted): there is no event to answer yet.
    if (!posted || posted.eventId.startsWith("pending:")) continue;
    humans ??= await deps.humansFor(boardId);
    const decision = gateDecisionRecord(g, posted, (deps.now ?? Date.now)());
    for (const reader of humans) noteFleet(reader, { type: "decision-asked", decision });
  }
}
