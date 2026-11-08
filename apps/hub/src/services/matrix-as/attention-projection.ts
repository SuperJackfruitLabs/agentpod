/**
 * Posting a waiting card into its board room, exactly once per wait, and the reads its answer
 * needs. The I/O half; `attention-wire.ts` holds the pure half.
 *
 * A near-mirror of `projectDelivery` on purpose: the claim in `matrix_attention_events` is taken
 * BEFORE the send, so push, the board's redelivery and the sweep — all meant to overlap — post one
 * card; a send that throws or is refused gives the claim back, so a later pass retries rather than
 * reading a dead row as handled; and nothing is posted before a human has joined the room to
 * receive its key.
 */

import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixAttentionEvents } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import { noteHubEvent } from "../push";
import { boardLink } from "./gate-wire";
import { attentionOptionsV2, attentionV2Content, type AttentionPendingDelivery } from "./attention-wire";
import type { RecordedAttention } from "./attention-answer";

const log = createLogger("matrix-attention");

export type AttentionProjectionOutcome =
  | { status: "posted"; roomId: string; eventId: string }
  | { status: "already" }
  | { status: "no-room" }
  | { status: "not-accepted" }
  /** Held, with no row, until a human has joined the board room (the gate's rule, 2026-10-07). */
  | { status: "awaiting-join"; roomId: string };

export interface AttentionProjectionDeps {
  boardRoom(
    boardId: string,
    tenantId: string,
    opts?: { boardName?: string },
  ): Promise<{ roomId: string; speakerMxid: string } | null>;
  humanJoined?(roomId: string, speakerMxid: string): Promise<boolean>;
  sendText(userId: string, roomId: string, body: string, extra?: Record<string, unknown>): Promise<string | null>;
  boardBaseUrl?: string;
  /** A posted card is a pending decision on the board's humans' fleet Live Activity (`fleet-attention.ts`). */
  onAttentionPosted?(d: AttentionPendingDelivery, posted: { roomId: string; eventId: string }): Promise<void>;
}

/** The three columns that name one wait. */
export interface WaitKey {
  boardId: string;
  cardId: string;
  waitId: string;
}

const where = (k: WaitKey) =>
  and(
    eq(matrixAttentionEvents.boardId, k.boardId),
    eq(matrixAttentionEvents.cardId, k.cardId),
    eq(matrixAttentionEvents.waitId, k.waitId),
  );

async function releaseClaim(k: WaitKey): Promise<void> {
  await db.delete(matrixAttentionEvents).where(where(k));
}

async function alreadyPosted(k: WaitKey): Promise<boolean> {
  const [row] = await db.select({ waitId: matrixAttentionEvents.waitId }).from(matrixAttentionEvents).where(where(k)).limit(1);
  return row !== undefined;
}

/**
 * Post a waiting card into its board's room, exactly once per wait. The claim records what the
 * card offers — exactly what its attention.v2 carries — because an answer is checked against it.
 */
export async function projectAttention(
  tenantId: string,
  d: AttentionPendingDelivery,
  deps: AttentionProjectionDeps,
): Promise<AttentionProjectionOutcome> {
  const key: WaitKey = { boardId: d.boardId, cardId: d.cardId, waitId: d.waitId };
  const found = await deps.boardRoom(d.boardId, tenantId, d.boardName ? { boardName: d.boardName } : undefined);
  if (!found) {
    log.warn("waiting card has no board room to appear in", { ...key });
    return { status: "no-room" };
  }

  if (deps.humanJoined && !(await deps.humanJoined(found.roomId, found.speakerMxid))) {
    if (await alreadyPosted(key)) return { status: "already" };
    return { status: "awaiting-join", roomId: found.roomId };
  }

  const claimed = await db
    .insert(matrixAttentionEvents)
    .values({
      ...key,
      tenantId,
      roomId: found.roomId,
      // Replaced with the real id below; a `pending:` row is taken, and is nobody's answerable event.
      // JSON, so ids containing `:` cannot make two waits' placeholders collide on the unique index.
      eventId: `pending:${JSON.stringify([d.boardId, d.cardId, d.waitId])}`,
      options: attentionOptionsV2(d),
    })
    .onConflictDoNothing({
      target: [matrixAttentionEvents.boardId, matrixAttentionEvents.cardId, matrixAttentionEvents.waitId],
    })
    .returning({ waitId: matrixAttentionEvents.waitId });
  if (claimed.length === 0) return { status: "already" };

  const deepLink = boardLink(deps.boardBaseUrl, d.boardId, d.cardId);
  let eventId: string | null;
  try {
    const { body, ...v2 } = attentionV2Content(d, deepLink);
    eventId = await deps.sendText(found.speakerMxid, found.roomId, String(body), v2);
    noteHubEvent(eventId, "gate");
  } catch (err) {
    // Given back and re-thrown, as `projectGate` does: the push receiver keeps answering 5xx so
    // the board retries, and the sweep re-offers it.
    await releaseClaim(key);
    log.warn("waiting card could not be posted; claim released so a later pass retries", {
      ...key,
      roomId: found.roomId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  if (!eventId) {
    await releaseClaim(key);
    log.warn("waiting card was not accepted; claim released", { ...key, roomId: found.roomId });
    return { status: "not-accepted" };
  }

  await db.update(matrixAttentionEvents).set({ eventId }).where(where(key));
  log.info("waiting card projected", { ...key, roomId: found.roomId });
  await deps.onAttentionPosted?.(d, { roomId: found.roomId, eventId }).catch((err) =>
    log.warn("could not put a waiting card on the fleet card", {
      ...key,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  return { status: "posted", roomId: found.roomId, eventId };
}

/** What this hub recorded when it posted a waiting card; null when it never did, or is still sending. */
export async function recordedAttention(k: WaitKey): Promise<RecordedAttention | null> {
  const [row] = await db
    .select({
      boardId: matrixAttentionEvents.boardId,
      cardId: matrixAttentionEvents.cardId,
      waitId: matrixAttentionEvents.waitId,
      roomId: matrixAttentionEvents.roomId,
      eventId: matrixAttentionEvents.eventId,
      options: matrixAttentionEvents.options,
    })
    .from(matrixAttentionEvents)
    .where(where(k))
    .limit(1);
  if (!row || row.eventId.startsWith("pending:")) return null;
  return row;
}

/** Claim the waiting card's receipt; true exactly once per wait. */
export async function claimAttentionOutcome(k: WaitKey): Promise<boolean> {
  const claimed = await db
    .update(matrixAttentionEvents)
    .set({ outcomePostedAt: new Date() })
    .where(and(where(k), isNull(matrixAttentionEvents.outcomePostedAt)))
    .returning({ waitId: matrixAttentionEvents.waitId });
  return claimed.length > 0;
}

/**
 * Waiting cards this hub put in a room on a board and has said nothing final about — the local
 * half of settling the waits that ended elsewhere. Rows still mid-send are excluded.
 */
export async function postedAttentionAwaitingOutcome(boardId: string): Promise<WaitKey[]> {
  const rows = await db
    .select({
      boardId: matrixAttentionEvents.boardId,
      cardId: matrixAttentionEvents.cardId,
      waitId: matrixAttentionEvents.waitId,
      eventId: matrixAttentionEvents.eventId,
    })
    .from(matrixAttentionEvents)
    .where(and(eq(matrixAttentionEvents.boardId, boardId), isNull(matrixAttentionEvents.outcomePostedAt)));
  return rows
    .filter((r) => !r.eventId.startsWith("pending:"))
    .map((r) => ({ boardId: r.boardId, cardId: r.cardId, waitId: r.waitId }));
}
