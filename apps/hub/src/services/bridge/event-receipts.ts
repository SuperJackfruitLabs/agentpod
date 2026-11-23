/**
 * The event ids this hub has acted on, shared by the direct push and the event relay
 * (`superpipeline_event_receipts`). See `routes/superpipeline-decisions.ts` for how a door uses it.
 */
import { eq, lt } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { superpipelineEventReceipts } from "../../db/schema/event-receipts";

export interface EventReceipts {
  /** True when this call claimed `eventId`; false when a door already has. Atomic. */
  claim(eventId: string, via: string): Promise<boolean>;
  /** Give a claim back, so the door's retry is acted on. */
  release(eventId: string): Promise<void>;
}

/** How long a receipt is kept. Neither door redelivers an event this late. */
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export function createEventReceipts(now: () => number = Date.now): EventReceipts {
  let prunedAt = 0;
  return {
    async claim(eventId, via) {
      if (now() - prunedAt > PRUNE_EVERY_MS) {
        prunedAt = now();
        await db.delete(superpipelineEventReceipts).where(lt(superpipelineEventReceipts.receivedAt, new Date(now() - RECEIPT_TTL_MS)));
      }
      const [claimed] = await db
        .insert(superpipelineEventReceipts)
        .values({ eventId, via, receivedAt: new Date(now()) })
        .onConflictDoNothing()
        .returning({ eventId: superpipelineEventReceipts.eventId });
      return claimed !== undefined;
    },
    async release(eventId) {
      await db.delete(superpipelineEventReceipts).where(eq(superpipelineEventReceipts.eventId, eventId));
    },
  };
}
