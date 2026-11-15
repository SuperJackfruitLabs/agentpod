/** Proposed per-attempt evidence ledger. It never adopts another run's output. */
import { pgTable, text, bigint, timestamp, primaryKey, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";

export const checkpointDispatches = pgTable("checkpoint_dispatches", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  boardId: text("board_id").notNull(), runId: text("run_id").notNull(),
  leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull(), attemptId: text("attempt_id").notNull(),
  profile: text("profile").notNull(), claim: text("claim").notNull(), authority: text("authority").notNull(),
  prepareRequest: text("prepare_request").notNull(), prepareSHA256: text("prepare_sha256").notNull(),
  phase: text("phase").notNull(), prepared: text("prepared"), source: text("source"),
  sourceReceipt: text("source_receipt"), executeRequest: text("execute_request"), executeSHA256: text("execute_sha256"),
  completion: text("completion"), settlementBody: text("settlement_body"), settlementSHA256: text("settlement_sha256"),
  settlementReceipt: text("settlement_receipt"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.attemptId] }),
  uniqueIndex("checkpoint_dispatches_run_epoch_idx").on(t.tenantId, t.boardId, t.runId, t.leaseEpoch),
  check("checkpoint_dispatches_epoch", sql`${t.leaseEpoch} > 0 AND ${t.leaseEpoch} <= 9007199254740991`),
  check("checkpoint_dispatches_phase", sql`${t.phase} IN ('prepare_pending','prepared','source_pending','admitted','execute_pending','completed','submission_pending','reported')`),
]);
export type CheckpointDispatchRow = typeof checkpointDispatches.$inferSelect;
