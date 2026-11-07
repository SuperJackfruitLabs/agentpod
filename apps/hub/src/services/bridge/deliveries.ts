/**
 * What superpipeline pushes to this hub, and what the bridge's client reads back from a board:
 * a gate waiting on a reviewer and an agent's question waiting on an answer.
 *
 * Wire shapes only. They live with the bridge, which reads them off the board, so that the
 * bridge never reaches up into the Matrix appservice that posts them (`matrix-as/gates.ts`
 * and `matrix-as/elicitation-card.ts` re-export them and hold the rules about them).
 */

/** The body superpipeline pushes on `gate.pending`. */
export interface GatePendingDelivery {
  event: "gate.pending";
  boardId: string;
  cardId: string;
  gateId: string;
  stageKey: string;
  returnStageKey: string;
  cardTitle: string;
  producedBy: string;
  /**
   * What the reviewer is being asked to approve — the previous stage's
   * handoff, bounded by the board at 600 characters.
   *
   * Optional because a board that has not shipped superpipeline#… yet sends none,
   * and a gate without it must still render.
   */
  handoffSummary?: string | null;
  /**
   * What the board is CALLED, which this hub has no other way to learn — the board's
   * metadata route resolves a user session, the same wall that makes `humansFor` an
   * injected dependency.
   *
   * Optional, and that is load-bearing rather than politeness: a board that has not
   * shipped the field yet sends none, and the room must keep the name it has rather
   * than be renamed to nothing. See `renameIfNeeded`.
   */
  boardName?: string | null;
  /**
   * What the gate offers. `id` and `label` since v1; `meaning`, `needsComment` and `delivery`
   * since gate.v2 (charter: decisions/2026-11-07-gate-v2-is-the-decision-envelope.md).
   *
   * The gate.v2 fields are typed `unknown` on purpose: an older board sends none, and what a
   * board sends is checked before it is carried (`gateOptionsV2`), never trusted as typed.
   */
  options: Array<{ id: string; label: string; meaning?: unknown; needsComment?: unknown; delivery?: unknown }>;
  /**
   * The exact outbound action a subject-bound gate approves: `{ id, digest, schema, revision,
   * expiresAt, preview }`. Absent on a gate bound to no subject and from an older board.
   * `unknown` for the same reason as the options' gate.v2 fields — `gateSubjectV2` checks it.
   */
  approvalSubject?: unknown;
  /** The board's own path to the card, for a subject-bound gate. Not carried: `deep_link` is. */
  reviewUrl?: string | null;
  ts: string;
}

/** The body the board pushes on `elicitation.pending`. */
export interface ElicitationPendingDelivery {
  event: "elicitation.pending";
  boardId: string;
  /**
   * What the board is called. Optional because a board that has not shipped the field
   * sends none, and the room must keep the name it has rather than be renamed to
   * nothing — see `renameIfNeeded`.
   */
  boardName?: string | null;
  cardId: string;
  cardTitle: string;
  elicitationId: string;
  runId: string;
  stageKey: string;
  /** The agent that is waiting, and the one identity the board will not let answer. */
  agentId: string;
  /** The question. May be empty: an agent can stop on options alone. */
  question: string;
  options: Array<{ id: string; label: string }>;
  ts: string;
}
