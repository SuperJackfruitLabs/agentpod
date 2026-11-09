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
 * **Once.** A push is at-least-once and carries no arrival id. Each notice is claimed
 * (`matrix_check_notices`) on the card, the notice, the check and a digest of what the push says,
 * before anything is sent, and given back when the send fails: a redelivery (byte for byte the same)
 * posts nothing twice and the board's retry of a failed one posts it. A failure worded exactly like an
 * earlier one is said again once that claim is older than `REPEAT_AFTER_MS`, far past the board's
 * retries (five, over under three minutes), so a second arrival failing the same way is not silenced.
 */
import { createHash } from "node:crypto";

import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";

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
} from "./checks-wire";
import { boardRoomOf, soleTenant } from "./decision-notices";
import type { TenantsForBoard } from "./relay-scope";

const log = createLogger("matrix-check-notices");

/** How long a claim stands against an identical push before the same words may be said again. */
export const REPEAT_AFTER_MS = 30 * 60_000;

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

/** What the push says, as one digest: the redelivery of a push is the same bytes, so the same digest. */
function digestOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Act on a `check.failed`. Throws on a send failure, so the push is retried. */
export async function handleCheckFailed(d: CheckFailedDelivery, deps: CheckNoticeDeps): Promise<CheckNoticeOutcome> {
  // Checked by the route already; checked again so nothing below trusts the wire's spelling.
  if (!isCheckFailed(d)) return { status: "malformed" };
  const digest = digestOf([d.stageKey, d.check.provider, d.check.detail ?? null, d.check.url ?? null, d.returnedTo]);
  return sayInRoom(d, "failed", digest, deps, async (cardTitle, replyTo) => ({
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
  const digest = digestOf([d.stageKey, d.check.provider, d.by, d.at, d.comment]);
  return sayInRoom(d, "overridden", digest, deps, async (cardTitle, replyTo) => {
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
  d: { boardId: string; cardId: string; stageKey: string; check: { name: string } },
  notice: Notice,
  digest: string,
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
    notice,
    checkName: d.check.name,
    digest,
  };
  const claimKey = and(
    eq(matrixCheckNotices.boardId, key.boardId),
    eq(matrixCheckNotices.cardId, key.cardId),
    eq(matrixCheckNotices.notice, key.notice),
    eq(matrixCheckNotices.checkName, key.checkName),
    eq(matrixCheckNotices.digest, key.digest),
  );
  // A fresh claim, or one taken over from an identical notice said long ago (never from one still
  // being sent, whose event id is not yet recorded).
  const [claimed] = await db
    .insert(matrixCheckNotices)
    .values({ ...key, tenantId, roomId: room.roomId })
    .onConflictDoUpdate({
      target: [matrixCheckNotices.boardId, matrixCheckNotices.cardId, matrixCheckNotices.notice, matrixCheckNotices.checkName, matrixCheckNotices.digest],
      set: { createdAt: new Date(), eventId: null, tenantId, roomId: room.roomId },
      setWhere: and(isNotNull(matrixCheckNotices.eventId), lt(matrixCheckNotices.createdAt, new Date(Date.now() - REPEAT_AFTER_MS))),
    })
    .returning({ boardId: matrixCheckNotices.boardId });
  if (!claimed) return { status: "duplicate" };

  try {
    const waiting = await openWaitingCard(tenantId, d, room.roomId);
    const said = await compose(waiting?.cardTitle ?? (await knownTitle(tenantId, d.boardId, d.cardId)), waiting?.eventId ?? null);
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
 * The card's title, when this hub has heard it: the push carries none, and the board's card read is
 * not one this hub's credential reaches. A reminder or escalation about the card names it. Null
 * otherwise, and the sentence leaves it out.
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
