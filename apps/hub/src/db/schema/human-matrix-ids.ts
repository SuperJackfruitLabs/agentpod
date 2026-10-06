import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A person's Matrix id, by their principal: whom to invite to their agents' rooms, their boards and
 * their missions, and whose devices a live turn is pushed to.
 *
 * The org plane resolves a Matrix id to a principal (`GET /api/identities/matrix/:mxid`, contract
 * §3.5) but has no read in the other direction, and the hub asks that direction every time it
 * makes a room. So the hub keeps this answer itself:
 *
 * - seeded by the auth-table drop (migration 0095) from the humans' `matrix` rows of
 *   `principal_identities`, which that migration then drops;
 * - refreshed whenever an inbound Matrix sender resolves, through the plane, to a human
 *   (`services/matrix-identity.ts`), so a person linked at the plane after the cutover is learned
 *   the first time they speak.
 *
 * A record of sameness the plane already vouched for, never a grant: nothing reads authority out
 * of it. Humans only — an agent's Matrix id is built from its handle.
 */
export const humanMatrixIds = pgTable("human_matrix_ids", {
  principalId: text("principal_id").primaryKey(),
  matrixId: text("matrix_id").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
