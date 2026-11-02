/**
 * Who operates this hub.
 *
 * People's accounts live at the organization plane; the hub's Better Auth `user` table was dropped
 * after the rollback window (P3 plan, Task 17). What stays here is AgentPod's own seat:
 * `hub_operators` (decision D4), now for the hub-wide settings only (workspace authority spec, W2).
 * The admin dashboard's counts, which also read the plane's directory, are `services/admin-stats.ts`.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { hubOperators } from "../db/schema/operators";

/**
 * Is this principal an operator of this hub? A seat in `hub_operators` (decision D4). The id is a
 * `prn_` — a caller's `AuthUser.id`.
 */
export async function isUserAdmin(userId: string): Promise<boolean> {
  const [seat] = await db
    .select({ id: hubOperators.principalId })
    .from(hubOperators)
    .where(eq(hubOperators.principalId, userId))
    .limit(1);
  return !!seat;
}
