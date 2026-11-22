/**
 * SuperPipeline events this hub has acted on, by event id (treaty phase 2, rulings 1-2).
 *
 * A decision can reach the hub by two doors while the direct push and the event relay overlap:
 * both carry one id per event, `<boardId>:<event seq>`. The first door to claim the id acts; the
 * second finds the row and acknowledges without acting. A row is given back when acting fails, so
 * the retry is acted on. Rows older than a week are pruned: no door redelivers that late.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const superpipelineEventReceipts = pgTable(
  "superpipeline_event_receipts",
  {
    eventId: text("event_id").primaryKey(),
    /** The door that acted: `push` or `event-relay`. */
    via: text("via").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("superpipeline_event_receipts_received_idx").on(t.receivedAt)],
);
