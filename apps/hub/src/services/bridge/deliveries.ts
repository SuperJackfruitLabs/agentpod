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
  /**
   * When the decision is reminded and escalated, from its stage's timeout (charter: "Unanswered
   * decisions remind, then escalate" §5): `{ remindAt?, escalateAt? }`, ISO. Absent when no timeout
   * applies and from a board that predates it. `unknown`: checked before it is carried (`deadlineV2`).
   */
  deadline?: unknown;
  /**
   * A quorum gate's progress (charter 2026-11-09, more than one approver): `{ required, from,
   * approvals: [{ principalId, at, variantId? }] }`. Absent on a gate that passes on one approval
   * and from a board that predates it. `unknown`: checked before it is carried (`quorumV2`).
   */
  quorum?: unknown;
  /**
   * What would hold an approval of this gate before it acts (charter 2026-11-09, an approval may
   * wait for its release time §7): `{ holdForMinutes?, notBefore? }`. Absent when nothing holds it
   * and from a board that predates it. `unknown`: checked before it is carried (`releaseV2`).
   */
  release?: unknown;
  /**
   * The checks that ran before this gate opened (charter 2026-11-09, a gate may be decided by checks
   * §7): `[{ name, provider, status, url? }]`. Absent when the stage has none and from a board that
   * predates them. `unknown`: checked before it is carried (`checksV2`).
   */
  checks?: unknown;
  ts: string;
}

/**
 * The body the board pushes on `gate.approval_recorded`: an approval on a quorum gate that did not
 * yet reach it (charter 2026-11-09, more than one approver §7). The gate is still pending; the
 * approval that reaches the quorum resolves it and sends no `gate.approval_recorded`. Checked by
 * `isGateApprovalRecorded` before it is believed.
 */
export interface GateApprovalRecordedDelivery {
  event: "gate.approval_recorded";
  boardId: string;
  cardId: string;
  gateId: string;
  approval: { principalId: string; at: string; variantId?: string };
  quorum: {
    required: number;
    from: "deciders" | "admins";
    approvals: Array<{ principalId: string; at: string; variantId?: string }>;
  };
}

/**
 * The body the board pushes on `decision.released`: a held approval reached its release time and
 * acted, or was blocked (charter 2026-11-09, an approval may wait for its release time §5-7).
 * Checked by `isDecisionReleased` before it is believed.
 */
export interface DecisionReleasedDelivery {
  event: "decision.released";
  boardId: string;
  cardId: string;
  gateId: string;
  decision: string;
  releaseAt: string;
  releasedAt: string;
  outcome: "released" | "blocked";
  /** Why a release was blocked; only on `outcome: "blocked"`. */
  reason?: string;
}

/**
 * The body the board pushes on `decision.pulled_back`: a held approval was pulled back before its
 * release time, as request changes (charter 2026-11-09 §4). `pulledBackBy` is a principal id, never
 * carried into a room. Checked by `isDecisionPulledBack` before it is believed.
 */
export interface DecisionPulledBackDelivery {
  event: "decision.pulled_back";
  boardId: string;
  cardId: string;
  gateId: string;
  pulledBackBy: string;
  at: string;
  comment: string;
}

/** A check's provider and status, as the board names them (charter 2026-11-09, a gate may be decided by checks §1). */
export type CheckProvider = "ci" | "verdict";
export type CheckStatus = "pending" | "passed" | "failed" | "overridden";

/**
 * The body the board pushes on `check.failed`: a check on a card's arrival at a stage failed, and the
 * card went back to `returnedTo` (null: it could not go back and waits for a person). `arrivalId`
 * names the check set, `cardTitle` the card. Checked by `isCheckFailed` before it is believed.
 */
export interface CheckFailedDelivery {
  event: "check.failed";
  boardId: string;
  cardId: string;
  cardTitle: string;
  arrivalId: string;
  stageKey: string;
  check: { name: string; provider: CheckProvider; status: "failed"; detail?: string; url?: string };
  returnedTo: string | null;
}

/**
 * The body the board pushes on `check.overridden`: a workspace owner or admin passed a check by hand
 * (charter 2026-11-09 §5). `by` is a principal id (or the board's local id), never carried into a
 * room. Checked by `isCheckOverridden` before it is believed.
 */
export interface CheckOverriddenDelivery {
  event: "check.overridden";
  boardId: string;
  cardId: string;
  cardTitle: string;
  arrivalId: string;
  stageKey: string;
  check: { name: string; provider: CheckProvider; status: "overridden" };
  by: string;
  comment: string;
  at: string;
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
  /**
   * `id` and `label` since the first version; `meaning`, `needsComment` and `input` since the
   * decision envelope covers questions (charter: "The decision envelope covers questions and
   * follow-ups"). The newer fields are `unknown` for the reason the gate's are: an older board
   * sends none, and they are checked before they are carried (`questionOptionsV2`).
   */
  options: Array<{
    id: string;
    label: string;
    meaning?: unknown;
    needsComment?: unknown;
    input?: unknown;
    /** `once` | `run` | `always`, and `workspace-admin` (charter: strict decisions bind their subject §2). */
    scope?: unknown;
    requires?: unknown;
  }>;
  /** On a question with no options: it is answered by typing, at most `maxLength` characters. */
  freeText?: unknown;
  /**
   * The exact thing an approving answer approves, on a strict decision (`salaam-operation/v1`) or
   * a poster-bound harness permission (`harness-permission/v1`): `{id, digest, schema, revision,
   * expiresAt, preview, previewComplete}`, camelCase like a gate's. `unknown`: checked before it is
   * carried (`questionSubjectV2`). Absent from a board that predates it, and on any other question.
   */
  approvalSubject?: unknown;
  /**
   * A SuperToolkit approval request (`apr_…`, equal to `elicitationId`) hosted on the board
   * (charter: "Waiting cards and broker approvals reach chat" §3). It belongs to no card, run or
   * stage, so `cardId`, `runId` and `stageKey` are empty and the room must not link to a card.
   */
  approvalRequestId?: unknown;
  /**
   * When the decision is reminded and escalated, from its stage's timeout (charter: "Unanswered
   * decisions remind, then escalate" §5): `{ remindAt?, escalateAt? }`, ISO. Absent when no timeout
   * applies and from a board that predates it. `unknown`: checked before it is carried (`deadlineV2`).
   */
  deadline?: unknown;
  ts: string;
}

/**
 * The body the board pushes on `attention.pending`: a card parked for a person for a reason other
 * than a question or a review — `repeated-failure`, `blocked` or `not-authorised` (charter: "Waiting
 * cards and broker approvals reach chat" §1). Also what `GET /v1/boards/:id/attention/pending`
 * lists, for the sweep. `waitId` names this particular wait: a card that parks again is a new one.
 *
 * Everything past the identifiers is `unknown`: checked and bounded before it is carried
 * (`attentionV2Content`), never trusted as typed.
 */
export interface AttentionPendingDelivery {
  event: "attention.pending";
  boardId: string;
  boardName?: string | null;
  cardId: string;
  cardTitle: string;
  stageKey: string;
  stageName?: unknown;
  waitId: string;
  reason: string;
  detail?: unknown;
  summary?: unknown;
  failureCount?: unknown;
  earlierStages?: unknown;
  options: unknown[];
  /**
   * When the decision is reminded and escalated, from its stage's timeout (charter: "Unanswered
   * decisions remind, then escalate" §5): `{ remindAt?, escalateAt? }`, ISO. Absent when no timeout
   * applies and from a board that predates it. `unknown`: checked before it is carried (`deadlineV2`).
   */
  deadline?: unknown;
  ts?: string;
}

/**
 * The body the board pushes on `delivery.pending`: a post approved for manual delivery still owes
 * the board its live link (charter: "The decision envelope covers questions and follow-ups" §3).
 * Also what `GET /v1/boards/:id/deliveries/pending` lists, for the sweep.
 *
 * `approvalSubject` and each option's envelope fields are `unknown`: checked before they are
 * carried (`deliveryV2Content`), never trusted as typed.
 */
export interface DeliveryPendingDelivery {
  event: "delivery.pending";
  boardId: string;
  boardName?: string | null;
  cardId: string;
  cardTitle: string;
  gateId: string;
  stageKey: string;
  approvalSubject?: unknown;
  options: Array<{ id: string; label: string; meaning?: unknown; needsComment?: unknown; input?: unknown; delivery?: unknown }>;
  /**
   * When the decision is reminded and escalated, from its stage's timeout (charter: "Unanswered
   * decisions remind, then escalate" §5): `{ remindAt?, escalateAt? }`, ISO. Absent when no timeout
   * applies and from a board that predates it. `unknown`: checked before it is carried (`deadlineV2`).
   */
  deadline?: unknown;
  ts: string;
}

/**
 * The kinds of decision a stage's timeout applies to (charter: "Unanswered decisions remind, then
 * escalate" §1). `checks` is a card's check set waiting on its machine checks (charter 2026-11-09, a
 * gate may be decided by checks §4); its decision id is the arrival's id.
 */
export const DECISION_KINDS = ["gate", "question", "delivery", "attention", "checks"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * The body the board pushes on `decision.reminded` and `decision.escalated`: a waiting decision passed
 * its stage's timeout (charter: "Unanswered decisions remind, then escalate" §2). `decisionId` is the
 * gate id (gate, delivery), the elicitation id (question), the wait id (attention) or the check set's
 * arrival id (checks). Each is sent at most once per wait; `remindedAt` rides on the first, `escalatedAt` on the second.
 */
export interface DecisionTimeoutDelivery {
  event: "decision.reminded" | "decision.escalated";
  boardId: string;
  boardName?: string | null;
  cardId: string;
  cardTitle: string;
  stageKey: string;
  stageName?: string | null;
  decisionKind: DecisionKind;
  decisionId: string;
  waitingSince: string;
  remindedAt?: string;
  escalatedAt?: string;
  ts: string;
}
