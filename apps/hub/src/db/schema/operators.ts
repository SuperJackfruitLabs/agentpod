import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Who may operate this hub, by principal id: AgentPod's own seat (decision D4; design §4,
 * "product seats … stay in each product"). The plane's token carries no role, so under
 * ORG_PLANE_* `isUserAdmin` asks this table instead of `user.role`. Read only when ORG_PLANE_* is
 * set; seeded from `user.role = 'admin'` by scripts/rewrite-user-ids.ts at cutover.
 */
export const hubOperators = pgTable("hub_operators", {
  principalId: text("principal_id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: text("created_by"),
});
