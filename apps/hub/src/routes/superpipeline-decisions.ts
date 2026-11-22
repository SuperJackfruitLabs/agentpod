/**
 * The eleven decision events SuperPipeline sends this hub, and what each does here: one handler,
 * shared by both doors that carry them (treaty phase 2, ruling 1).
 *
 * - **The direct push** (`POST /public/bridge/superpipeline/push`), a board's own push config.
 * - **The suite's event relay** (`POST /public/bridge/superpipeline/events`), one CloudEvent per
 *   event, since phase 2 for all eleven types rather than `gate.pending` alone.
 *
 * During the move a decision can arrive by both. Each event has one id on both paths,
 * `<boardId>:<event seq>` (ruling 2), and `handleDecisionOnce` claims that id before acting, so the
 * second arrival is acknowledged and goes nowhere. Every handler is also idempotent on its own domain
 * key (the gate, the question, the notice), which stays the floor beneath it: a delivery with no
 * vouched-for id (a board that predates the move, or the old signature) still posts once.
 *
 * Each body is checked by treaty's guard (`@superjackfruitlabs/treaty-matrix-events`) before it is
 * believed. Authentication is the door's; nothing here reads a header.
 */
import { createLogger } from "../utils/logger";
import { isBoardMoved, projectGate, type GatePendingDelivery, type GateProjectionDeps } from "../services/board-chat";
import { projectElicitation, projectDelivery, projectAttention } from "../services/board-chat";
import type { AttentionProjectionDeps, DecisionNoticeDeps, DecisionNoticeOutcome } from "../services/board-chat";
import { handleDecisionTimeout, handleGateApprovalRecorded, handleDecisionPulledBack, handleDecisionReleased } from "../services/board-chat";
import type { GateProgressOutcome, GateHoldOutcome, CheckNoticeOutcome } from "../services/board-chat";
import { handleCheckFailed, handleCheckOverridden } from "../services/board-chat";
import {
  isApprovalRequest,
  isAttentionPending,
  isCheckFailed,
  isCheckOverridden,
  isDecisionPulledBack,
  isDecisionReleased,
  isDecisionTimeout,
  isDeliveryPending,
  isElicitationPending,
  isGateApprovalRecorded,
  isGatePending,
} from "@superjackfruitlabs/treaty-matrix-events";
import type {
  CheckFailedDelivery,
  CheckOverriddenDelivery,
  DecisionPulledBackDelivery,
  DecisionReleasedDelivery,
  DecisionTimeoutDelivery,
  GateApprovalRecordedDelivery,
} from "../services/bridge";
import { PUSH_EVENTS, type EventReceipts } from "../services/bridge";

const log = createLogger("superpipeline-decisions");

/** Which door a decision came through, as the log says it. */
export type DecisionDoor = "push" | "event-relay";

/** The eleven decision events, by the name the board puts in `event`. */
export const DECISION_EVENTS: readonly string[] = PUSH_EVENTS;

/** A decision event's CloudEvents type, as treaty's catalogue names it. */
export function decisionEventType(name: string): string {
  return `com.superjackfruit.superpipeline.${name}.v1`;
}

/** CloudEvents type → the `event` name its data carries, for the eleven. */
export const DECISION_TYPES: ReadonlyMap<string, string> = new Map(DECISION_EVENTS.map((name) => [decisionEventType(name), name]));

export interface DecisionDeps extends GateProjectionDeps {
  /** Which fleet this board's gates belong to. */
  tenantIdFor(boardId: string): Promise<string | null>;
  /** A posted waiting card goes on the board's humans' fleet Live Activity (`boardProjectionDeps`). */
  onAttentionPosted?: AttentionProjectionDeps["onAttentionPosted"];
  /**
   * May a SuperToolkit approval request on `boardId` be posted into `tenantId`'s room — the tenant
   * this push is routed to? True only when the relay is that workspace's and no other tenant knows
   * the board (`relay-scope.ts`). Absent: no approval request is ever posted.
   */
  approvalRequestAllowed?(tenantId: string, boardId: string): Promise<boolean>;
  /** Invite a workspace admin into a board room when a decision escalates (`boardProjectionDeps`). */
  invite?: DecisionNoticeDeps["invite"];
  /** A tenant's workspace owners and admins, as Matrix ids (`boardProjectionDeps`). */
  workspaceAdmins?: DecisionNoticeDeps["workspaceAdmins"];
  /** A card's checks as the board reads them, listed when overdue checks escalate (`boardProjectionDeps`). */
  checksForCard?: DecisionNoticeDeps["checksForCard"];
  /** How to name an approver in a quorum gate's progress reply: their handle, never an mxid. */
  displayNameFor?(principalId: string): Promise<string | null>;
  /**
   * The event ids already acted on, shared by both doors (`event-receipts.ts`). Absent: no id is
   * claimed, and each handler's own domain-key idempotency is the only dedupe.
   */
  receipts?: EventReceipts;
  /** Test seam: what a gate does. Defaults to `projectPushedGate`. */
  projectGate?(body: GatePendingDelivery, via: DecisionDoor): Promise<DecisionResult>;
  /** Test seam: what a reminder or escalation does. Defaults to `handleDecisionTimeout`. */
  handleDecisionTimeout?(d: DecisionTimeoutDelivery): Promise<DecisionNoticeOutcome>;
  /** Test seam: what a quorum gate's recorded approval does. Defaults to `handleGateApprovalRecorded`. */
  handleGateApprovalRecorded?(d: GateApprovalRecordedDelivery): Promise<GateProgressOutcome>;
  /** Test seam: what a held approval's release does. Defaults to `handleDecisionReleased`. */
  handleDecisionReleased?(d: DecisionReleasedDelivery): Promise<GateHoldOutcome>;
  /** Test seam: what a held approval's pull-back does. Defaults to `handleDecisionPulledBack`. */
  handleDecisionPulledBack?(d: DecisionPulledBackDelivery): Promise<GateHoldOutcome>;
  /** Test seam: what a failed check does. Defaults to `handleCheckFailed`. */
  handleCheckFailed?(d: CheckFailedDelivery): Promise<CheckNoticeOutcome>;
  /** Test seam: what an overridden check does. Defaults to `handleCheckOverridden`. */
  handleCheckOverridden?(d: CheckOverriddenDelivery): Promise<CheckNoticeOutcome>;
}

export interface DecisionResult {
  status: 200 | 400 | 404 | 422 | 503;
  body: Record<string, unknown>;
  /** Set when the body names a decision event but treaty's guard refuses its data. Never sent. */
  invalid?: true;
}

/**
 * `handleDecision`, at most once per event id. The id is claimed before the handler runs, so two
 * doors delivering one event at the same moment act once; it is given back when the handler throws
 * or answers anything but 2xx, so the door's retry is acted on rather than taken for a duplicate.
 * A null id (a board that predates the move) is not claimed.
 */
export async function handleDecisionOnce(
  eventId: string | null,
  body: unknown,
  deps: DecisionDeps,
  via: DecisionDoor,
): Promise<DecisionResult> {
  const receipts = deps.receipts;
  if (!receipts || !eventId) return handleDecision(body, deps, via);
  if (!(await receipts.claim(eventId, via))) {
    log.info("decision already handled through the other door; not acted on again", { eventId, via });
    return { status: 200, body: { ok: true, status: "duplicate" } };
  }
  let result: DecisionResult;
  try {
    result = await handleDecision(body, deps, via);
  } catch (err) {
    await receipts.release(eventId);
    throw err;
  }
  if (result.status !== 200 || result.invalid) await receipts.release(eventId);
  return result;
}

/** One decision body, whichever door it came through. */
export async function handleDecision(body: unknown, deps: DecisionDeps, via: DecisionDoor): Promise<DecisionResult> {
  // A board whose chat has moved out of this hub (`moved-boards.ts`): nothing it pushes is posted
  // here. 200, so the board does not retry what this hub will never post.
  const boardId = typeof body === "object" && body !== null && "boardId" in body ? body.boardId : undefined;
  if (typeof boardId === "string" && isBoardMoved(boardId)) {
    log.info("push for a board whose chat has moved; not posted", { boardId });
    return { status: 200, body: { ok: true, status: "moved" } };
  }

  /**
   * An agent's question travels the same door as a gate.
   *
   * Both are "a person must answer before this card moves", both are signed the
   * same way, and both are refused the same way when the shape is not one this
   * build knows. Checked before the gate so the two predicates cannot both claim a
   * body — they are disjoint today, and a future field that made them overlap
   * should fail here rather than project twice.
   */
  if (isElicitationPending(body)) {
    const tenantId = await deps.tenantIdFor(body.boardId);
    if (!tenantId) {
      log.warn("push for a board mapped to no fleet", { boardId: body.boardId });
      return { status: 404, body: { error: "unknown board" } };
    }
    // An approval request carries every argument in full: it goes only into the room of the
    // relay's own workspace. Dropped (200: a retry would not change it), and said in the log.
    if (isApprovalRequest(body) && !(await deps.approvalRequestAllowed?.(tenantId, body.boardId))) {
      log.warn("an approval request was pushed for a board the relay does not serve here; not posted", {
        boardId: body.boardId,
        elicitationId: body.elicitationId,
      });
      return { status: 200, body: { ok: true, ignored: true } };
    }
    const outcome = await projectElicitation(tenantId, body, deps);
    log.info("question projected", {
      via,
      elicitationId: body.elicitationId,
      status: outcome.status,
    });
    return { status: 200, body: { ok: true, status: outcome.status } };
  }

  /**
   * The follow-up a manual-delivery approval owes (charter: "The decision envelope covers
   * questions and follow-ups" §3), through the same door and refused the same way. Disjoint
   * from the other two by `event`.
   */
  if (isDeliveryPending(body)) {
    const tenantId = await deps.tenantIdFor(body.boardId);
    if (!tenantId) {
      log.warn("push for a board mapped to no fleet", { boardId: body.boardId });
      return { status: 404, body: { error: "unknown board" } };
    }
    const outcome = await projectDelivery(tenantId, body, deps);
    log.info("delivery follow-up projected", { gateId: body.gateId, status: outcome.status });
    return { status: 200, body: { ok: true, status: outcome.status } };
  }

  /**
   * A card waiting on a person (charter: "Waiting cards and broker approvals reach chat" §1),
   * through the same door and refused the same way. Disjoint from the others by `event`.
   */
  if (isAttentionPending(body)) {
    const tenantId = await deps.tenantIdFor(body.boardId);
    if (!tenantId) {
      log.warn("push for a board mapped to no fleet", { boardId: body.boardId });
      return { status: 404, body: { error: "unknown board" } };
    }
    const outcome = await projectAttention(tenantId, body, deps);
    log.info("waiting card projected", { cardId: body.cardId, waitId: body.waitId, status: outcome.status });
    return { status: 200, body: { ok: true, status: outcome.status } };
  }

  /**
   * A waiting decision passed its stage's timeout (charter: "Unanswered decisions remind, then
   * escalate" §2-3): a reply to the card this hub posted, and on escalation the workspace admins
   * invited. The board each picks by its own tenant rule (`decision-notices.ts`), so no
   * `tenantIdFor` here. Disjoint from the others by `event`.
   */
  if (isDecisionTimeout(body)) {
    const outcome = deps.handleDecisionTimeout
      ? await deps.handleDecisionTimeout(body)
      : await handleDecisionTimeout(body, deps);
    log.info("decision timeout handled", { event: body.event, decisionId: body.decisionId, status: outcome.status });
    return { status: 200, body: { ok: true, status: outcome.status } };
  }

  /**
   * An approval on a quorum gate short of its quorum (charter: "A gate may need more than one
   * approver" §7): a progress reply to the gate card this hub posted. The board picks its tenant
   * by the reminder's rule (one tenant or nobody, `gate-progress.ts`), so no `tenantIdFor` here.
   * Disjoint from the others by `event`.
   */
  if (isGateApprovalRecorded(body)) {
    const outcome = deps.handleGateApprovalRecorded
      ? await deps.handleGateApprovalRecorded(body)
      : await handleGateApprovalRecorded(body, deps);
    log.info("quorum gate approval handled", { gateId: body.gateId, status: outcome.status });
    return { status: 200, body: { ok: true, status: outcome.status } };
  }

  /**
   * A held approval released at its release time, or pulled back before it (charter: "An approval
   * may wait for its release time" §7): a reply to the gate card this hub posted. One tenant or
   * nobody, as for progress (`gate-hold.ts`). Disjoint from the others by `event`.
   */
  if (isDecisionReleased(body)) {
    const outcome = deps.handleDecisionReleased
      ? await deps.handleDecisionReleased(body)
      : await handleDecisionReleased(body, deps);
    log.info("held approval release handled", { gateId: body.gateId, outcome: body.outcome, status: outcome.status });
    return { status: 200, body: { ok: true, status: outcome.status } };
  }
  if (isDecisionPulledBack(body)) {
    const outcome = deps.handleDecisionPulledBack
      ? await deps.handleDecisionPulledBack(body)
      : await handleDecisionPulledBack(body, deps);
    log.info("held approval pull-back handled", { gateId: body.gateId, status: outcome.status });
    return { status: 200, body: { ok: true, status: outcome.status } };
  }

  /**
   * A machine check failed and returned the card, or was overridden (charter: "A gate may be decided
   * by checks" §7): a line in the board's room. One tenant or nobody, as for a reminder
   * (`check-notices.ts`). Disjoint from the others by `event`.
   */
  if (isCheckFailed(body)) {
    const outcome = deps.handleCheckFailed ? await deps.handleCheckFailed(body) : await handleCheckFailed(body, deps);
    log.info("failed check handled", { boardId: body.boardId, cardId: body.cardId, check: body.check.name, status: outcome.status });
    return { status: 200, body: { ok: true, status: outcome.status } };
  }
  if (isCheckOverridden(body)) {
    const outcome = deps.handleCheckOverridden ? await deps.handleCheckOverridden(body) : await handleCheckOverridden(body, deps);
    log.info("overridden check handled", { boardId: body.boardId, cardId: body.cardId, check: body.check.name, status: outcome.status });
    return { status: 200, body: { ok: true, status: outcome.status } };
  }

  if (!isGatePending(body)) {
    // Another event superpipeline pushes — work.available, gate.resolved — or a
    // shape this build does not know. 200, because it was delivered fine and
    // a non-2xx would make the board retry something it will never like.
    const said = typeof body === "object" && body !== null && "event" in body ? body.event : undefined;
    const invalid = typeof said === "string" && DECISION_EVENTS.includes(said);
    return invalid ? { status: 200, body: { ok: true, ignored: true }, invalid: true } : { status: 200, body: { ok: true, ignored: true } };
  }
  return deps.projectGate ? deps.projectGate(body, via) : projectPushedGate(body, deps, via);
}

/**
 * A gate into its board's room: the one place both doors hand a `gate.pending` to `projectGate`.
 * Idempotent on the gate id, so the two doors may both deliver the same gate. `via` names the door
 * in the log, which is how a staging proof tells them apart.
 */
export async function projectPushedGate(
  body: GatePendingDelivery,
  deps: Pick<DecisionDeps, "tenantIdFor"> & GateProjectionDeps,
  via: DecisionDoor,
): Promise<DecisionResult> {
  const tenantId = await deps.tenantIdFor(body.boardId);
  if (!tenantId) {
    log.warn("gate for a board mapped to no fleet", { boardId: body.boardId, via });
    return { status: 404, body: { error: "unknown board" } };
  }
  const outcome = await projectGate(tenantId, body, deps);
  log.info("gate projected", { gateId: body.gateId, status: outcome.status, via });
  return { status: 200, body: { ok: true, status: outcome.status } };
}
