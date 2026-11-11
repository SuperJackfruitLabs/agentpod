/**
 * Where an encrypted event waits for its key: `matrix_pending_decrypts`.
 *
 * Held in the database, not in memory. The homeserver has been told the transaction was applied
 * by the time an event is parked, so it never sends it again: an event parked in memory was lost,
 * silently, by any restart before its key arrived. On 2026-11-11 a gate approved from chat across
 * a hub restart never reached the board that way.
 *
 * Every row is the event as the homeserver delivered it, still encrypted.
 */

import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { matrixPendingDecrypts } from "../../db/schema/matrix";

/** How long an event may wait for its key before it is given up on. */
export const PENDING_TTL_MS = 5 * 60_000;
/** At most this many wait; a room whose keys never come must not grow the table without end. */
export const PENDING_MAX = 200;

export interface ParkedEvent {
  eventId: string;
  roomId: string;
  event: Record<string, unknown>;
  firstSeenAt: Date;
}

/**
 * Park an event. True when it is newly parked, false when it was already waiting (a homeserver
 * retry, or a second attempt at the same event). Over `PENDING_MAX`, the oldest are dropped.
 */
export async function park(eventId: string, roomId: string, event: Record<string, unknown>): Promise<boolean> {
  const inserted = await db
    .insert(matrixPendingDecrypts)
    .values({ eventId, roomId, event })
    .onConflictDoNothing({ target: matrixPendingDecrypts.eventId })
    .returning({ eventId: matrixPendingDecrypts.eventId });
  if (inserted.length === 0) return false;

  const over = await db
    .select({ eventId: matrixPendingDecrypts.eventId })
    .from(matrixPendingDecrypts)
    .orderBy(sql`${matrixPendingDecrypts.firstSeenAt} desc`, sql`${matrixPendingDecrypts.eventId} desc`)
    .offset(PENDING_MAX);
  if (over.length > 0) {
    await db.delete(matrixPendingDecrypts).where(
      inArray(
        matrixPendingDecrypts.eventId,
        over.map((r) => r.eventId),
      ),
    );
  }
  return true;
}

/** Everything waiting, oldest first. */
export async function waiting(): Promise<ParkedEvent[]> {
  return db.select().from(matrixPendingDecrypts).orderBy(asc(matrixPendingDecrypts.firstSeenAt));
}

/**
 * Take an event off the list. True only for the caller that removed it, so two retries running at
 * once never act on the same event twice.
 */
export async function claim(eventId: string): Promise<boolean> {
  const removed = await db
    .delete(matrixPendingDecrypts)
    .where(eq(matrixPendingDecrypts.eventId, eventId))
    .returning({ eventId: matrixPendingDecrypts.eventId });
  return removed.length > 0;
}
