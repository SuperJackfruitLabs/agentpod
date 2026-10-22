import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Who may operate this hub, by principal id: AgentPod's own seat (decision D4; design §4,
 * "product seats … stay in each product"). Since the workspace authority spec (2026-10-22) it
 * gates only what no workspace owns — the hub-wide settings, the all-tenant audit read; a
 * workspace's admins come from the token's `orgRole`. Seeded from the old `user.role = 'admin'`
 * at the P4 cutover; set from `HUB_OPERATORS` at boot (`services/hub-operators.ts`), never by hand.
 */
export const hubOperators = pgTable("hub_operators", {
  principalId: text("principal_id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: text("created_by"),
});
