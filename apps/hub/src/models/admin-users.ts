/**
 * Who operates this hub, and the admin dashboard's counts.
 *
 * People's accounts live at the organization plane; the hub's Better Auth `user` table was dropped
 * after the rollback window (P3 plan, Task 17). What stays here is AgentPod's own seat:
 * `hub_operators` (decision D4) — the plane's token carries no role.
 */

import { count, eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { hubOperators } from "../db/schema/operators";
import { principalDirectory } from "../services/org-plane/directory";

export interface AdminStats {
  totalUsers: number;
  adminUsers: number;
  bannedUsers: number;
  totalSandboxes: number;
  runningSandboxes: number;
  usersThisWeek: number;
}

/**
 * The admin dashboard's counts. People are the humans of this hub's workspace at the plane
 * (contract §3.5 lists them); "banned" is the plane's suspension. The plane reports no sign-up
 * time, so `usersThisWeek` is 0.
 */
export async function getAdminStats(): Promise<AdminStats> {
  const humans = await principalDirectory().list("human");
  const [operators] = await db.select({ count: count() }).from(hubOperators);
  return {
    totalUsers: humans.length,
    adminUsers: operators?.count ?? 0,
    bannedUsers: humans.filter((h) => h.suspended).length,
    totalSandboxes: 0,
    runningSandboxes: 0,
    usersThisWeek: 0,
  };
}

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
