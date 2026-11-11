/**
 * Moving an escalated decision's card below, for the workspace admins who just joined
 * (charter: "Unanswered decisions remind, then escalate" §3: they "see what the room sees,
 * including a subject's full preview, and answer it like anyone in the room").
 *
 * A board room is encrypted to the members joined when a message is sent, so an admin an
 * escalation invited cannot read the card posted before they joined. When their join is seen, the
 * card is posted again — the full current envelope, rebuilt by the same builders from a fresh read
 * of what the board is waiting on — and **the decision's record moves to the new event**:
 *
 * - The record keeps everything an answer is judged against — options, subject binding, wait id,
 *   the receipt's claim. Only its event id changes, and only if the fresh envelope still offers the
 *   same options under the same subject; otherwise nothing moves.
 * - An answer referencing the old card then fails the existing reference check and acts on
 *   nothing, so the decision cannot be answered twice. The old card gets a short "moved below"
 *   reply, so a reader there knows where it went.
 * - The move is conditional on the record still pointing at the old event and still open: an
 *   answer (or another move) that lands mid-move wins, and the new copy says it does not count.
 *
 * Bounded: once per invited admin's join (the join is claimed once per board and person), and not
 * at all when the current card was posted after that admin joined, since they can read it.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { GATE_REQUEST_CONTENT_KEY } from "@agentpod/contract";

import { db } from "../../db/drizzle";
import {
  matrixAttentionEvents,
  matrixDeliveryEvents,
  matrixElicitationEvents,
  matrixGateEvents,
} from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import { noteHubEvent } from "../push";
import type {
  AttentionPendingDelivery,
  DecisionKind,
  DeliveryPendingDelivery,
  ElicitationPendingDelivery,
  GatePendingDelivery,
} from "../bridge";
import {
  attentionOptionsV2,
  attentionV2Content,
  isAttentionPending,
  deliveryOptionsV2,
  deliverySubjectV2,
  deliveryV2Content,
  isDeliveryPending,
  GATE_EVENT_TYPE,
  boardLink,
  gateEventContent,
  gateOptionsV2,
  gateRequestCard,
  gateSubjectV2,
  gateV2Content,
  gateVariantsV2,
  isGatePending,
  boundedQuestion,
  questionOptionsV2,
  questionSubjectV2,
  questionV2Content,
} from "@superjackfruitlabs/treaty-matrix-events";
import { ELICITATION_REQUEST_CONTENT_KEY, elicitationRequestCard, isElicitationPending } from "./elicitation-card";
import { legacyRequestEvents } from "./legacy-events";

const log = createLogger("matrix-decision-repost");

export const MOVED_BELOW_TEXT =
  "Moved below, so the workspace admins who just joined can read it. Answer the copy below; this one no longer counts.";
export const SETTLED_ABOVE_TEXT = "That one was answered or moved while this copy was being posted; nothing to answer here.";

export interface CardRepostDeps {
  boardBaseUrl?: string;
  sendText(userId: string, roomId: string, body: string, extra?: Record<string, unknown>): Promise<string | null>;
  sendCustomEvent?(userId: string, roomId: string, eventType: string, content: Record<string, unknown>): Promise<string | null>;
  /** Everything the board is waiting on now, read fresh; throws when it cannot be read. */
  pendingOnBoard?(boardId: string): Promise<unknown[]>;
  /**
   * The fleet Live Activity's record of a gate or waiting card, noted again after a move so a
   * phone's answer references the card that counts (`fleet-gates.ts`, `fleet-attention.ts`).
   */
  onPosted?(d: GatePendingDelivery, posted: { roomId: string; eventId: string; proseEventId: string | null }): Promise<void>;
  onAttentionPosted?(d: AttentionPendingDelivery, posted: { roomId: string; eventId: string }): Promise<void>;
}

export interface MoveTarget {
  boardId: string;
  cardId: string;
  decisionKind: DecisionKind;
  decisionId: string;
}

export type MoveOutcome = "moved" | "not-pending" | "changed" | "not-sent" | "settled";

const ids = (options: ReadonlyArray<{ id: string; meaning?: string }> | null | undefined): string =>
  (options ?? []).map((o) => `${o.id}:${o.meaning ?? ""}`).join("|");

/**
 * A variant gate's subjects as one comparable value — what a re-posted card must still offer for the
 * record its answers are judged against to hold (charter 2026-11-09). Null when there are none.
 */
const variantsKey = (variants: ReadonlyArray<{ id: string; digest: string }> | null | undefined): string | null =>
  variants && variants.length > 0 ? variants.map((v) => `${v.id}@${v.digest}`).join("|") : null;

const reply = (eventId: string) => ({ "m.relates_to": { "m.in_reply_to": { event_id: eventId } } });

/** A decision's record as the move needs it: where its card is, and what an answer is judged against. */
interface Recorded {
  eventId: string;
  open: boolean;
  options: string;
  subjectDigest: string | null;
}

/** The fresh envelope for this decision, with what it would record and the card it would post. */
interface Rebuilt {
  options: string;
  subjectDigest: string | null;
  content: Record<string, unknown>;
  /** A gate also posts its legacy custom event while v1 clients need it. */
  legacy?: Record<string, unknown>;
  /** The envelope, for the kinds the fleet Live Activity shows. */
  gate?: GatePendingDelivery;
  attention?: AttentionPendingDelivery;
}

function rebuild(t: MoveTarget, pending: unknown[], link: string | undefined): Rebuilt | null {
  for (const p of pending) {
    if (t.decisionKind === "gate" && isGatePending(p) && p.gateId === t.decisionId && p.cardId === t.cardId) {
      const d: GatePendingDelivery = p;
      return {
        options: ids(gateOptionsV2(d)),
        subjectDigest: gateSubjectV2(d)?.digest ?? variantsKey(gateVariantsV2(d)?.map((v) => ({ id: v.id, digest: v.subject.digest }))),
        content: { ...gateV2Content(d, link), [GATE_REQUEST_CONTENT_KEY]: gateRequestCard(d, link) },
        legacy: gateEventContent(d, link),
        gate: d,
      };
    }
    if (t.decisionKind === "question" && isElicitationPending(p) && p.elicitationId === t.decisionId && p.cardId === t.cardId) {
      const d: ElicitationPendingDelivery = boundedQuestion(p);
      return {
        options: ids(questionOptionsV2(d)),
        subjectDigest: questionSubjectV2(d)?.digest ?? null,
        content: { ...questionV2Content(d, link), [ELICITATION_REQUEST_CONTENT_KEY]: elicitationRequestCard(d, link) },
      };
    }
    if (t.decisionKind === "delivery" && isDeliveryPending(p) && p.gateId === t.decisionId && p.cardId === t.cardId) {
      const d: DeliveryPendingDelivery = p;
      return { options: ids(deliveryOptionsV2(d)), subjectDigest: deliverySubjectV2(d)?.digest ?? null, content: deliveryV2Content(d, link) };
    }
    if (t.decisionKind === "attention" && isAttentionPending(p) && p.waitId === t.decisionId && p.cardId === t.cardId) {
      const d: AttentionPendingDelivery = p;
      return { options: ids(attentionOptionsV2(d)), subjectDigest: null, content: attentionV2Content(d, link), attention: d };
    }
  }
  return null;
}

async function recorded(t: MoveTarget, tenantId: string): Promise<Recorded | null> {
  const mine = (r: { tenantId: string; boardId: string; cardId: string }) => r.tenantId === tenantId && r.boardId === t.boardId && r.cardId === t.cardId;
  if (t.decisionKind === "gate") {
    const [r] = await db.select().from(matrixGateEvents).where(eq(matrixGateEvents.gateId, t.decisionId)).limit(1);
    return r && mine(r) ? { eventId: r.proseEventId ?? r.eventId, open: r.outcomePostedAt === null, options: ids(r.options), subjectDigest: r.approvalSubjectDigest ?? variantsKey(r.approvalVariants) } : null;
  }
  if (t.decisionKind === "question") {
    const [r] = await db.select().from(matrixElicitationEvents).where(eq(matrixElicitationEvents.elicitationId, t.decisionId)).limit(1);
    // A question recorded before question.v2 has no options to judge a structured answer by: it stays.
    return r && mine(r) && r.optionsV2 ? { eventId: r.eventId, open: r.outcomePostedAt === null, options: ids(r.optionsV2), subjectDigest: r.approvalSubjectDigest } : null;
  }
  if (t.decisionKind === "delivery") {
    const [r] = await db.select().from(matrixDeliveryEvents).where(eq(matrixDeliveryEvents.gateId, t.decisionId)).limit(1);
    return r && mine(r) ? { eventId: r.eventId, open: r.outcomePostedAt === null, options: ids(r.options), subjectDigest: r.approvalSubjectDigest } : null;
  }
  const [r] = await db
    .select()
    .from(matrixAttentionEvents)
    .where(and(eq(matrixAttentionEvents.boardId, t.boardId), eq(matrixAttentionEvents.cardId, t.cardId), eq(matrixAttentionEvents.waitId, t.decisionId)))
    .limit(1);
  return r && mine(r) ? { eventId: r.eventId, open: r.outcomePostedAt === null, options: ids(r.options), subjectDigest: null } : null;
}

/** Point the record at the new card, only if it still points at the old one and is still open. */
async function moveRecord(t: MoveTarget, oldEventId: string, posted: { eventId: string; proseEventId: string }): Promise<boolean> {
  if (t.decisionKind === "gate") {
    const moved = await db
      .update(matrixGateEvents)
      .set({ eventId: posted.eventId, proseEventId: posted.proseEventId })
      .where(
        and(
          eq(matrixGateEvents.gateId, t.decisionId),
          // The card's event is the prose, or the legacy event for a gate from before the prose key.
          or(eq(matrixGateEvents.proseEventId, oldEventId), eq(matrixGateEvents.eventId, oldEventId)),
          isNull(matrixGateEvents.outcomePostedAt),
        ),
      )
      .returning({ id: matrixGateEvents.gateId });
    return moved.length > 0;
  }
  if (t.decisionKind === "question") {
    const moved = await db
      .update(matrixElicitationEvents)
      .set({ eventId: posted.proseEventId })
      .where(and(eq(matrixElicitationEvents.elicitationId, t.decisionId), eq(matrixElicitationEvents.eventId, oldEventId), isNull(matrixElicitationEvents.outcomePostedAt)))
      .returning({ id: matrixElicitationEvents.elicitationId });
    return moved.length > 0;
  }
  if (t.decisionKind === "delivery") {
    const moved = await db
      .update(matrixDeliveryEvents)
      .set({ eventId: posted.proseEventId })
      .where(and(eq(matrixDeliveryEvents.gateId, t.decisionId), eq(matrixDeliveryEvents.eventId, oldEventId), isNull(matrixDeliveryEvents.outcomePostedAt)))
      .returning({ id: matrixDeliveryEvents.gateId });
    return moved.length > 0;
  }
  const moved = await db
    .update(matrixAttentionEvents)
    .set({ eventId: posted.proseEventId })
    .where(
      and(
        eq(matrixAttentionEvents.boardId, t.boardId),
        eq(matrixAttentionEvents.cardId, t.cardId),
        eq(matrixAttentionEvents.waitId, t.decisionId),
        eq(matrixAttentionEvents.eventId, oldEventId),
        isNull(matrixAttentionEvents.outcomePostedAt),
      ),
    )
    .returning({ id: matrixAttentionEvents.waitId });
  return moved.length > 0;
}

/**
 * Post a decision's card again below and move its record there. `pending` is the board's fresh
 * read. Never throws for a decision that cannot move: the old card simply stays the one that counts.
 */
export async function moveCardBelow(
  t: MoveTarget,
  tenantId: string,
  room: { roomId: string; speakerMxid: string },
  pending: unknown[],
  deps: CardRepostDeps,
): Promise<MoveOutcome> {
  const was = await recorded(t, tenantId);
  if (!was?.open || was.eventId.startsWith("pending:")) return "settled";
  const fresh = rebuild(t, pending, boardLink(deps.boardBaseUrl, t.boardId, t.cardId));
  if (!fresh) return "not-pending";
  if (fresh.options !== was.options || fresh.subjectDigest !== was.subjectDigest) {
    log.warn("an escalated card was not moved: the board now offers it differently from what was recorded", {
      boardId: t.boardId,
      decisionKind: t.decisionKind,
      decisionId: t.decisionId,
    });
    return "changed";
  }

  const { body, ...rest } = fresh.content;
  const proseEventId = await deps.sendText(room.speakerMxid, room.roomId, String(body), rest);
  if (!proseEventId) return "not-sent";
  noteHubEvent(proseEventId, "gate");
  let eventId = proseEventId;
  if (fresh.legacy && legacyRequestEvents() && deps.sendCustomEvent) {
    const legacy = await deps.sendCustomEvent(room.speakerMxid, room.roomId, GATE_EVENT_TYPE, fresh.legacy);
    if (legacy) {
      noteHubEvent(legacy, "companion");
      eventId = legacy;
    }
  }

  if (!(await moveRecord(t, was.eventId, { eventId, proseEventId }))) {
    await deps.sendText(room.speakerMxid, room.roomId, SETTLED_ABOVE_TEXT, reply(proseEventId));
    return "settled";
  }
  // The record has moved: what follows must not fail the move, or a retry would post the card twice.
  await deps
    .sendText(room.speakerMxid, room.roomId, MOVED_BELOW_TEXT, reply(was.eventId))
    .catch((err: unknown) => log.warn("a moved card's old copy could not be told", { decisionId: t.decisionId, error: String(err) }));
  // The Lock Screen's copy moves with the record: an Approve from a phone references what it was
  // given, and the old card's event is refused now (`reference-mismatch`).
  const announced = fresh.gate
    ? deps.onPosted?.(fresh.gate, { roomId: room.roomId, eventId, proseEventId })
    : fresh.attention
      ? deps.onAttentionPosted?.(fresh.attention, { roomId: room.roomId, eventId: proseEventId })
      : undefined;
  await announced?.catch((err: unknown) =>
    log.warn("a moved card could not be shown again on the fleet card", { decisionId: t.decisionId, error: String(err) }),
  );
  log.info("moved an escalated card below for an admin who joined", { boardId: t.boardId, decisionKind: t.decisionKind, decisionId: t.decisionId });
  return "moved";
}
