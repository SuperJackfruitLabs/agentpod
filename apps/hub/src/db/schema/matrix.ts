import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Applied Application Service transactions.
 *
 * The homeserver retries what it did not see acknowledged. This is what makes a
 * retry a no-op instead of a second conversation.
 */
export const matrixAsTransactions = pgTable("matrix_as_transactions", {
  txnId: text("txn_id").primaryKey(),
  appliedAt: timestamp("applied_at").notNull().defaultNow(),
});
