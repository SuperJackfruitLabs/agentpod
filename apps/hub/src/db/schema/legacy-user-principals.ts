import { pgTable, text } from "drizzle-orm/pg-core";

/**
 * Better Auth user id → human prn_, frozen at cutover by `scripts/rewrite-user-ids.ts`.
 *
 * Permanent (the auth-table drop keeps it): other planes recorded hub user ids before the cutover
 * (superpipeline's `decided_by_hub_sub`), and those must keep resolving through
 * `GET /api/evidence/principals/:id` after `principal_identities` is gone. Empty, and unread, while
 * `ORG_PLANE_*` is unset.
 */
export const legacyUserPrincipals = pgTable("legacy_user_principals", {
  userId: text("user_id").primaryKey(),
  principalId: text("principal_id").notNull(),
});
