import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Who may operate this hub, by principal id: AgentPod's own seat (decision D4; design §4,
 * "product seats … stay in each product"). The plane's token carries no role, so `isUserAdmin`
 * asks this table. Seeded from the old `user.role = 'admin'` at the P4 cutover; a new operator is
 * a row added by hand (`INSERT INTO hub_operators (principal_id) VALUES ('prn_…')`).
 */
export const hubOperators = pgTable("hub_operators", {
  principalId: text("principal_id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: text("created_by"),
});
