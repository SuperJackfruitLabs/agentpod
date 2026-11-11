/**
 * The card an escalation of overdue checks posts (charter: "A gate may be decided by checks" §4, §7).
 *
 * A check set waits on its stage before any gate opens, so when its stage's timeout escalates there
 * is no card in the room to reply to. The escalation (`decision-notices.ts`) posts one: a
 * `dev.agentpod.checks.waiting.v2` card listing the card's checks as the board reads them now
 * (`GET …/cards/:cardId/checks`), which is what a client needs to offer **Override**; its escalation
 * notice replies to it, as every other kind's notice replies to its card. A person's
 * `dev.superpipeline.check.override.v2` must reference it (`check-override.ts`).
 *
 * Once per check set (`matrix_checks_waiting`, keyed by the board's arrival id), claimed before it is
 * sent and given back when the send fails. An admin the escalation invited cannot read a card posted
 * before they joined, so their join posts it again from a fresh read and moves the record to the new
 * event, and the old copy says it moved, as `decision-repost.ts` does for the other kinds.
 *
 * Imported by `decision-notices.ts`, never the other way round.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixChecksWaiting } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import type { DecisionTimeoutDelivery } from "../bridge";
import { checksV2, checksWaitingContent, type CheckV2, boardLink } from "@superjackfruitlabs/treaty-matrix-events";
import { MOVED_BELOW_TEXT, SETTLED_ABOVE_TEXT } from "./decision-repost";

const log = createLogger("matrix-checks-waiting");

/** The board's read of a card's checks (`SuperpipelineClient.cardChecks`); throws when it cannot be read. */
export type ChecksForCard = (boardId: string, cardId: string) => Promise<{ stageKey: string; status: string; checks: unknown[] } | null>;

export interface ChecksWaitingDeps {
  boardBaseUrl?: string;
  sendText(userId: string, roomId: string, body: string, extra?: Record<string, unknown>): Promise<string | null>;
  /** The board's read of a card's checks. Absent: an escalation of overdue checks posts its notice only. */
  checksForCard?: ChecksForCard;
}

interface Room {
  roomId: string;
  speakerMxid: string;
}

const posted = (eventId: string | null | undefined): eventId is string => !!eventId && !eventId.startsWith("pending:");

/**
 * The checks an escalation's card lists, from the board's read now, or null when there is nothing to
 * offer an override on: no read wired, the card at no stage with checks, its checks over (`status`
 * not `open`) or at another stage than the one that timed out, or a list this hub will not carry. A
 * board that cannot be read throws, so the push is retried before anything is claimed.
 */
export async function readWaitingChecks(
  d: Pick<DecisionTimeoutDelivery, "boardId" | "cardId" | "stageKey">,
  deps: Pick<ChecksWaitingDeps, "checksForCard">,
): Promise<CheckV2[] | null> {
  if (!deps.checksForCard) return null;
  const read = await deps.checksForCard(d.boardId, d.cardId);
  if (!read || read.status !== "open" || read.stageKey !== d.stageKey) return null;
  return checksV2(read.checks);
}

const contentFor = (
  w: { boardId: string; cardId: string; cardTitle: string; stageKey: string; stageName?: string | null },
  checks: CheckV2[],
  deps: Pick<ChecksWaitingDeps, "boardBaseUrl">,
) =>
  checksWaitingContent(
    { boardId: w.boardId, cardId: w.cardId, cardTitle: w.cardTitle, stageKey: w.stageKey, stageName: w.stageName, checks },
    boardLink(deps.boardBaseUrl, w.boardId, w.cardId),
  );

/**
 * Post the checks.waiting card for an escalated check set, once, and return its event — or the event
 * of the one already posted for it. Null when another delivery is posting it right now: the notice
 * then stands alone rather than wait. Throws on a send failure, with the claim given back.
 */
export async function postChecksWaitingCard(
  d: DecisionTimeoutDelivery,
  tenantId: string,
  room: Room,
  checks: CheckV2[],
  deps: ChecksWaitingDeps,
): Promise<string | null> {
  const key = and(eq(matrixChecksWaiting.boardId, d.boardId), eq(matrixChecksWaiting.decisionId, d.decisionId));
  const [claimed] = await db
    .insert(matrixChecksWaiting)
    .values({
      boardId: d.boardId,
      decisionId: d.decisionId,
      tenantId,
      cardId: d.cardId,
      cardTitle: d.cardTitle,
      stageKey: d.stageKey,
      roomId: room.roomId,
    })
    .onConflictDoNothing()
    .returning({ boardId: matrixChecksWaiting.boardId });
  if (!claimed) {
    const [existing] = await db.select().from(matrixChecksWaiting).where(key).limit(1);
    return existing && existing.tenantId === tenantId && existing.roomId === room.roomId && posted(existing.eventId)
      ? existing.eventId
      : null;
  }
  try {
    const { body, ...extra } = contentFor(d, checks, deps);
    const eventId = await deps.sendText(room.speakerMxid, room.roomId, String(body), extra);
    if (!posted(eventId)) throw new Error("the checks.waiting card was not given an event id");
    await db.update(matrixChecksWaiting).set({ eventId }).where(key);
    return eventId;
  } catch (err) {
    await db.delete(matrixChecksWaiting).where(key);
    throw err;
  }
}

/** The checks.waiting card this hub posted for a check set, in this tenant, on this board and card; or null. */
export async function checksWaitingCardFor(
  tenantId: string,
  boardId: string,
  cardId: string,
  decisionId: string,
): Promise<{ roomId: string; eventId: string; open: boolean } | null> {
  const [row] = await db
    .select()
    .from(matrixChecksWaiting)
    .where(and(eq(matrixChecksWaiting.boardId, boardId), eq(matrixChecksWaiting.decisionId, decisionId)))
    .limit(1);
  if (!row || row.tenantId !== tenantId || row.cardId !== cardId || !posted(row.eventId)) return null;
  return { roomId: row.roomId, eventId: row.eventId, open: row.closedAt === null };
}

/** What this hub recorded when it posted a checks.waiting card, found by its event; or null. */
export interface RecordedChecksCard {
  tenantId: string;
  boardId: string;
  cardId: string;
  roomId: string;
  eventId: string;
}

/** The checks.waiting card whose current event is `eventId`, or null when this hub posted none. */
export async function recordedChecksCard(eventId: string): Promise<RecordedChecksCard | null> {
  const [row] = await db.select().from(matrixChecksWaiting).where(eq(matrixChecksWaiting.eventId, eventId)).limit(1);
  return row && posted(row.eventId)
    ? { tenantId: row.tenantId, boardId: row.boardId, cardId: row.cardId, roomId: row.roomId, eventId: row.eventId }
    : null;
}

/**
 * Post an escalated check set's card again for a workspace admin who just joined, from a fresh read
 * of its checks, and move the record to the new event; the old copy is told it moved. `moved`, or why
 * not: the card is not open, its checks are over or cannot be read (`not-pending`), or another move
 * won (`settled`). A send failure throws, so the join's retry finishes it.
 */
export async function moveChecksCardBelow(
  target: { boardId: string; cardId: string; decisionId: string; stageKey: string; stageName?: string | null },
  tenantId: string,
  room: Room,
  deps: ChecksWaitingDeps,
): Promise<"moved" | "not-pending" | "settled"> {
  const [row] = await db
    .select()
    .from(matrixChecksWaiting)
    .where(and(eq(matrixChecksWaiting.boardId, target.boardId), eq(matrixChecksWaiting.decisionId, target.decisionId)))
    .limit(1);
  if (!row || row.tenantId !== tenantId || row.cardId !== target.cardId || row.roomId !== room.roomId || row.closedAt || !posted(row.eventId)) {
    return "settled";
  }
  let checks: CheckV2[] | null;
  try {
    checks = await readWaitingChecks({ boardId: target.boardId, cardId: target.cardId, stageKey: row.stageKey }, deps);
  } catch (err) {
    log.warn("could not read a card's checks to move its escalation below; posting the notice only", {
      boardId: target.boardId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "not-pending";
  }
  if (!checks) return "not-pending";
  const before = row.eventId;
  const { body, ...extra } = contentFor({ ...row, stageName: target.stageName }, checks, deps);
  const eventId = await deps.sendText(room.speakerMxid, room.roomId, String(body), extra);
  if (!posted(eventId)) return "not-pending";
  const [moved] = await db
    .update(matrixChecksWaiting)
    .set({ eventId })
    .where(
      and(
        eq(matrixChecksWaiting.boardId, target.boardId),
        eq(matrixChecksWaiting.decisionId, target.decisionId),
        eq(matrixChecksWaiting.eventId, before),
        isNull(matrixChecksWaiting.closedAt),
      ),
    )
    .returning({ boardId: matrixChecksWaiting.boardId });
  if (!moved) {
    await deps.sendText(room.speakerMxid, room.roomId, SETTLED_ABOVE_TEXT, { "m.relates_to": { "m.in_reply_to": { event_id: eventId } } });
    return "settled";
  }
  await deps.sendText(room.speakerMxid, room.roomId, MOVED_BELOW_TEXT, { "m.relates_to": { "m.in_reply_to": { event_id: before } } });
  return "moved";
}
