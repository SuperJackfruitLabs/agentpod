/**
 * Posting a delivery follow-up into its gate's board room, exactly once, and the reads its answer
 * needs. The I/O half; `@superjackfruitlabs/treaty-matrix-events` holds the pure half.
 *
 * A near-mirror of `projectGate` on purpose: the claim in `matrix_delivery_events` is taken BEFORE
 * the send, so push, the board's redelivery and the sweep — all meant to overlap — post one
 * follow-up; a send that throws or is refused gives the claim back, so a later pass retries
 * rather than reading a dead row as handled; and nothing is posted before a human has joined the
 * room to receive its key.
 */

import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixDeliveryEvents } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import { noteHubEvent } from "../push";
import {
  boardLink,
  deliveryOptionsV2,
  deliverySubjectV2,
  deliveryV2Content,
  type DeliveryPendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { RecordedDelivery } from "./delivery-answer";

const log = createLogger("matrix-deliveries");

export type DeliveryProjectionOutcome =
  | { status: "posted"; roomId: string; eventId: string }
  | { status: "already" }
  | { status: "no-room" }
  | { status: "not-accepted" }
  /** Held, with no row, until a human has joined the board room (the gate's rule, 2026-10-07). */
  | { status: "awaiting-join"; roomId: string };

export interface DeliveryProjectionDeps {
  boardRoom(
    boardId: string,
    tenantId: string,
    opts?: { boardName?: string },
  ): Promise<{ roomId: string; speakerMxid: string } | null>;
  humanJoined?(roomId: string, speakerMxid: string): Promise<boolean>;
  sendText(userId: string, roomId: string, body: string, extra?: Record<string, unknown>): Promise<string | null>;
  boardBaseUrl?: string;
}

async function releaseClaim(gateId: string): Promise<void> {
  await db.delete(matrixDeliveryEvents).where(eq(matrixDeliveryEvents.gateId, gateId));
}

async function alreadyPosted(gateId: string): Promise<boolean> {
  const [row] = await db
    .select({ gateId: matrixDeliveryEvents.gateId })
    .from(matrixDeliveryEvents)
    .where(eq(matrixDeliveryEvents.gateId, gateId))
    .limit(1);
  return row !== undefined;
}

/**
 * Post a follow-up into its board's room, exactly once per gate.
 *
 * The claim records what the follow-up offers and its subject's completeness — exactly what its
 * delivery.v2 carries — because an answer is checked against them.
 */
export async function projectDelivery(
  tenantId: string,
  d: DeliveryPendingDelivery,
  deps: DeliveryProjectionDeps,
): Promise<DeliveryProjectionOutcome> {
  const found = await deps.boardRoom(d.boardId, tenantId, d.boardName ? { boardName: d.boardName } : undefined);
  if (!found) {
    log.warn("delivery follow-up has no board room to appear in", { gateId: d.gateId, boardId: d.boardId });
    return { status: "no-room" };
  }

  if (deps.humanJoined && !(await deps.humanJoined(found.roomId, found.speakerMxid))) {
    if (await alreadyPosted(d.gateId)) return { status: "already" };
    return { status: "awaiting-join", roomId: found.roomId };
  }

  const subject = deliverySubjectV2(d);
  const claimed = await db
    .insert(matrixDeliveryEvents)
    .values({
      gateId: d.gateId,
      tenantId,
      boardId: d.boardId,
      cardId: d.cardId,
      roomId: found.roomId,
      // Replaced with the real id below; a `pending:` row is taken, and is nobody's answerable event.
      eventId: `pending:${d.gateId}`,
      options: deliveryOptionsV2(d),
      approvalSubjectId: subject?.id ?? null,
      approvalSubjectDigest: subject?.digest ?? null,
      approvalSubjectPreviewComplete: subject?.preview_complete ?? null,
    })
    .onConflictDoNothing({ target: matrixDeliveryEvents.gateId })
    .returning({ gateId: matrixDeliveryEvents.gateId });
  if (claimed.length === 0) return { status: "already" };

  const deepLink = boardLink(deps.boardBaseUrl, d.boardId, d.cardId);
  let eventId: string | null;
  try {
    const { body, ...v2 } = deliveryV2Content(d, deepLink);
    eventId = await deps.sendText(found.speakerMxid, found.roomId, String(body), v2);
    noteHubEvent(eventId, "gate");
  } catch (err) {
    // Given back and re-thrown, as `projectGate` does: the push receiver keeps answering 5xx so
    // the board retries, and the sweep re-offers it.
    await releaseClaim(d.gateId);
    log.warn("delivery follow-up could not be posted; claim released so a later pass retries", {
      gateId: d.gateId,
      roomId: found.roomId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  if (!eventId) {
    await releaseClaim(d.gateId);
    log.warn("delivery follow-up was not accepted; claim released", { gateId: d.gateId, roomId: found.roomId });
    return { status: "not-accepted" };
  }

  await db.update(matrixDeliveryEvents).set({ eventId }).where(eq(matrixDeliveryEvents.gateId, d.gateId));
  log.info("delivery follow-up projected", { gateId: d.gateId, roomId: found.roomId });
  return { status: "posted", roomId: found.roomId, eventId };
}

/** What this hub recorded when it posted a follow-up; null when it never did, or is still sending. */
export async function recordedDelivery(gateId: string): Promise<RecordedDelivery | null> {
  const [row] = await db
    .select({
      boardId: matrixDeliveryEvents.boardId,
      roomId: matrixDeliveryEvents.roomId,
      eventId: matrixDeliveryEvents.eventId,
      options: matrixDeliveryEvents.options,
      subjectPreviewComplete: matrixDeliveryEvents.approvalSubjectPreviewComplete,
    })
    .from(matrixDeliveryEvents)
    .where(eq(matrixDeliveryEvents.gateId, gateId))
    .limit(1);
  if (!row || row.eventId.startsWith("pending:")) return null;
  return row;
}

/** Claim the follow-up's receipt; true exactly once per gate. */
export async function claimDeliveryOutcome(gateId: string): Promise<boolean> {
  const claimed = await db
    .update(matrixDeliveryEvents)
    .set({ outcomePostedAt: new Date() })
    .where(and(eq(matrixDeliveryEvents.gateId, gateId), isNull(matrixDeliveryEvents.outcomePostedAt)))
    .returning({ gateId: matrixDeliveryEvents.gateId });
  return claimed.length > 0;
}

/**
 * Follow-ups this hub put in a room on a board and has said nothing final about — the local half
 * of settling the ones the board no longer owes. Rows still mid-send are excluded.
 */
export async function postedDeliveriesAwaitingOutcome(boardId: string): Promise<Array<{ gateId: string }>> {
  const rows = await db
    .select({ gateId: matrixDeliveryEvents.gateId, eventId: matrixDeliveryEvents.eventId })
    .from(matrixDeliveryEvents)
    .where(and(eq(matrixDeliveryEvents.boardId, boardId), isNull(matrixDeliveryEvents.outcomePostedAt)));
  return rows.filter((r) => !r.eventId.startsWith("pending:")).map((r) => ({ gateId: r.gateId }));
}
