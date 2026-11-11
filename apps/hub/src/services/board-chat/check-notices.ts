/**
 * A failed or overridden check, in the room (charter: "A gate may be decided by checks" §7).
 * SuperPipeline runs the checks; when one fails it returns the card and pushes `check.failed`, and
 * when an owner or admin passes one by hand it pushes `check.overridden`. This hub says each in the
 * board's room, once, beside a structured event (`dev.agentpod.check.failed.v2`,
 * `dev.agentpod.check.overridden.v2`).
 *
 * **One tenant or nobody**, as for a reminder (`decision-notices.ts`): a push carries no tenant, and a
 * board known to several tenants here has no single room to say it in. **The board's room only**: a
 * board with no room for that tenant says nothing.
 *
 * **What it replies to.** Checks run before a gate opens, so there is no gate card to reply to, and an
 * earlier gate card on the same card is a different decision. The one card this hub may have posted
 * about these checks is the checks.waiting card an escalation posted (`checks-waiting.ts`): when one
 * is open for this card and stage in the board's room, the notice replies to it and the structured
 * half references it, so a client can mark that card. Otherwise the notice is a standalone line about
 * the card. A failure that sent the card back closes that checks.waiting card: its checks are over,
 * and the next arrival's are new.
 *
 * **Once per arrival.** A push is at-least-once. Each notice is claimed (`matrix_check_notices`) on the
 * board, the card, the check set's arrival, the notice and the check, before anything is sent, and
 * given back when the send fails: a redelivery posts nothing twice (nor while the first is still being
 * sent), the board's retry of a failed one posts it, and the same check failing again on the card's
 * next arrival is said again, however alike the words.
 *
 * **The card's title** comes with the push; an empty one falls back to what this hub recorded.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixCheckNotices, matrixChecksWaiting, matrixDecisionNotices } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import type { CheckFailedDelivery, CheckOverriddenDelivery } from "../bridge";
import {
  CHECK_FAILED_TYPE,
  CHECK_OVERRIDDEN_TYPE,
  checkFailedBody,
  checkFailedContent,
  checkOverriddenBody,
  checkOverriddenContent,
  isCheckFailed,
  isCheckOverridden,
} from "@superjackfruitlabs/treaty-matrix-events";
import { boardRoomOf, soleTenant } from "./decision-notices";
import type { TenantsForBoard } from "./relay-scope";

const log = createLogger("matrix-check-notices");

export interface CheckNoticeDeps {
  sendText(userId: string, roomId: string, body: string, extra?: Record<string, unknown>): Promise<string | null>;
  /** The structured half, beside the prose. Absent: only the prose is posted. */
  sendCustomEvent?(userId: string, roomId: string, eventType: string, content: Record<string, unknown>): Promise<string | null>;
  /** How to name the person who overrode a check: their handle, never an mxid. */
  displayNameFor?(principalId: string): Promise<string | null>;
  /** Every tenant that knows a board. Defaults to `tenantsForBoard`. */
  tenantsForBoard?: TenantsForBoard;
}

export type CheckNoticeOutcome =
  | { status: "sent" }
  | { status: "duplicate" | "no-room" | "unknown-board" | "ambiguous-board" | "malformed" };

type Notice = "failed" | "overridden";

const posted = (eventId: string | null | undefined): eventId is string => !!eventId && !eventId.startsWith("pending:");

/** Act on a `check.failed`. Throws on a send failure, so the push is retried. */
export async function handleCheckFailed(d: CheckFailedDelivery, deps: CheckNoticeDeps): Promise<CheckNoticeOutcome> {
  // Checked by the route already; checked again so nothing below trusts the wire's spelling.
  if (!isCheckFailed(d)) return { status: "malformed" };
  return sayInRoom(d, "failed", deps, async (cardTitle, replyTo) => ({
    body: checkFailedBody(d, cardTitle),
    eventType: CHECK_FAILED_TYPE,
    content: checkFailedContent(d, cardTitle, replyTo ?? undefined),
    // The card went back: these checks are over, and the card that stood for them closes.
    closesWaiting: d.returnedTo !== null,
  }));
}

/** Act on a `check.overridden`. Throws on a send failure, so the push is retried. */
export async function handleCheckOverridden(d: CheckOverriddenDelivery, deps: CheckNoticeDeps): Promise<CheckNoticeOutcome> {
  if (!isCheckOverridden(d)) return { status: "malformed" };
  return sayInRoom(d, "overridden", deps, async (cardTitle, replyTo) => {
    const who = await nameOf(d.by, deps);
    return {
      body: checkOverriddenBody(d, who, cardTitle),
      eventType: CHECK_OVERRIDDEN_TYPE,
      content: checkOverriddenContent(d, who, cardTitle, replyTo ?? undefined),
      closesWaiting: false,
    };
  });
}

interface Said {
  body: string;
  eventType: string;
  content: Record<string, unknown>;
  closesWaiting: boolean;
}

/** The shared half: find the room, claim the notice, say it, then the structured event. */
async function sayInRoom(
  d: { boardId: string; cardId: string; cardTitle: string; arrivalId: string; stageKey: string; check: { name: string } },
  notice: Notice,
  deps: CheckNoticeDeps,
  compose: (cardTitle: string | null, replyTo: string | null) => Promise<Said>,
): Promise<CheckNoticeOutcome> {
  const sole = await soleTenant(d.boardId, deps);
  if ("status" in sole) return sole;
  const { tenantId } = sole;

  const room = await boardRoomOf(d.boardId, tenantId);
  if (!room) {
    log.info("a check notice for a board with no room here; nothing said", { boardId: d.boardId, notice });
    return { status: "no-room" };
  }

  const key = {
    boardId: d.boardId,
    cardId: d.cardId,
    arrivalId: d.arrivalId,
    notice,
    checkName: d.check.name,
  };
  const claimKey = and(
    eq(matrixCheckNotices.boardId, key.boardId),
    eq(matrixCheckNotices.cardId, key.cardId),
    eq(matrixCheckNotices.arrivalId, key.arrivalId),
    eq(matrixCheckNotices.notice, key.notice),
    eq(matrixCheckNotices.checkName, key.checkName),
  );
  // Claimed once, held while it is sent and after: only a failed send gives it back.
  const [claimed] = await db
    .insert(matrixCheckNotices)
    .values({ ...key, tenantId, roomId: room.roomId })
    .onConflictDoNothing()
    .returning({ boardId: matrixCheckNotices.boardId });
  if (!claimed) return { status: "duplicate" };

  try {
    const waiting = await openWaitingCard(tenantId, d, room.roomId);
    const pushed = d.cardTitle.trim();
    const title = pushed !== "" ? pushed : (waiting?.cardTitle ?? (await knownTitle(tenantId, d.boardId, d.cardId)));
    const said = await compose(title, waiting?.eventId ?? null);
    const eventId = await deps.sendText(
      room.speakerMxid,
      room.roomId,
      said.body,
      waiting ? { "m.relates_to": { "m.in_reply_to": { event_id: waiting.eventId } } } : undefined,
    );
    await db.update(matrixCheckNotices).set({ eventId }).where(claimKey);
    if (said.closesWaiting && waiting) {
      await db
        .update(matrixChecksWaiting)
        .set({ closedAt: new Date() })
        .where(and(eq(matrixChecksWaiting.boardId, d.boardId), eq(matrixChecksWaiting.decisionId, waiting.decisionId)));
    }
    // The prose is in the room, so the claim stands from here: a failure of the structured half is
    // logged, not retried, or the board's retry would say it twice.
    try {
      await deps.sendCustomEvent?.(room.speakerMxid, room.roomId, said.eventType, said.content);
    } catch (err) {
      log.warn("a check notice was said but its structured half could not be sent", {
        boardId: d.boardId,
        cardId: d.cardId,
        notice,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    log.info("a check notice posted", { boardId: d.boardId, cardId: d.cardId, check: d.check.name, notice, replied: !!waiting });
    return { status: "sent" };
  } catch (err) {
    // Unclaimed, so the board's retry posts it.
    await db.delete(matrixCheckNotices).where(claimKey);
    throw err;
  }
}

/** The open checks.waiting card this hub posted for this card and stage, in the board's room. */
async function openWaitingCard(
  tenantId: string,
  d: { boardId: string; cardId: string; stageKey: string },
  roomId: string,
): Promise<{ decisionId: string; eventId: string; cardTitle: string } | null> {
  const [row] = await db
    .select()
    .from(matrixChecksWaiting)
    .where(
      and(
        eq(matrixChecksWaiting.boardId, d.boardId),
        eq(matrixChecksWaiting.cardId, d.cardId),
        eq(matrixChecksWaiting.stageKey, d.stageKey),
        eq(matrixChecksWaiting.tenantId, tenantId),
        eq(matrixChecksWaiting.roomId, roomId),
        isNull(matrixChecksWaiting.closedAt),
      ),
    )
    .orderBy(desc(matrixChecksWaiting.createdAt))
    .limit(1);
  return row && posted(row.eventId) ? { decisionId: row.decisionId, eventId: row.eventId, cardTitle: row.cardTitle } : null;
}

/**
 * The card's title from this hub's own records, for a push whose title is empty: a reminder or
 * escalation about the card names it. Null otherwise, and the sentence leaves it out.
 */
async function knownTitle(tenantId: string, boardId: string, cardId: string): Promise<string | null> {
  const [row] = await db
    .select({ cardTitle: matrixDecisionNotices.cardTitle })
    .from(matrixDecisionNotices)
    .where(and(eq(matrixDecisionNotices.boardId, boardId), eq(matrixDecisionNotices.cardId, cardId), eq(matrixDecisionNotices.tenantId, tenantId)))
    .orderBy(desc(matrixDecisionNotices.createdAt))
    .limit(1);
  const title = row?.cardTitle.trim() ?? "";
  return title === "" ? null : title;
}

/** Who overrode it, by handle, or null when that cannot be had: the sentence leaves them out. */
async function nameOf(principalId: string, deps: CheckNoticeDeps): Promise<string | null> {
  try {
    return (await deps.displayNameFor?.(principalId)) ?? null;
  } catch (err) {
    log.warn("could not name who overrode a check", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
