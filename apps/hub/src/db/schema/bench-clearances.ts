/**
 * Bench clearances: which checkpoint attempts' benches the hub has cleared, and why.
 *
 * One card keeps one bench from stage to stage and across review bounces (ruling 2026-11-23). The
 * clearing sweep (services/bridge/bench-clearing.ts) clears it once the card is done, reaches a
 * terminal state, is cancelled, or stays dormant, and records here every attempt of the card it
 * cleared, so the sweep never judges them again. A card that comes back after that gets a new
 * attempt, with no row here, and is judged afresh. A failed or refused reclaim records nothing: the
 * next sweep asks again.
 */
import { pgTable, text, timestamp, primaryKey, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { checkpointDispatches } from "./checkpoint-dispatch";
import { tenants } from "./tenants";

export const benchClearances = pgTable("bench_clearances", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  attemptId: text("attempt_id").notNull(),
  cardId: text("card_id").notNull(),
  /** Why the card's bench was cleared: `completed`, `terminal`, `cancelled` or `dormant`. */
  reason: text("reason").notNull(),
  /** What the node answered: `reclaimed`, `absent`, or `abandoned` when a dormant card's bench could never be reached. */
  outcome: text("outcome").notNull(),
  clearedAt: timestamp("cleared_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.attemptId] }),
  foreignKey({ columns: [t.tenantId, t.attemptId], foreignColumns: [checkpointDispatches.tenantId, checkpointDispatches.attemptId] }).onDelete("cascade"),
  check("bench_clearances_reason", sql`${t.reason} IN ('completed','terminal','cancelled','dormant')`),
  check("bench_clearances_outcome", sql`${t.outcome} IN ('reclaimed','absent','abandoned')`),
]);
export type BenchClearanceRow = typeof benchClearances.$inferSelect;
