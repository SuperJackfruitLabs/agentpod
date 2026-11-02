/**
 * The admin dashboard's counts.
 *
 * People's accounts live at the organization plane, so the counts read its directory; the seats
 * are `hub_operators` (`models/admin-users.ts`). Here rather than in `models/` because a model is a
 * table's reads and writes, and this reads the plane too.
 */

import { db } from "../db/drizzle";
import { hubOperators } from "../db/schema/operators";
import { principalDirectory } from "../auth/org-plane/directory";

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
export async function getAdminStats(opts: { org?: string } = {}): Promise<AdminStats> {
  // A workspace admin's counts are their workspace's (workspace authority spec): the humans whose
  // organization is the caller's `org`. Without an org (the static API_TOKEN) every human counts.
  const all = await principalDirectory().list("human");
  const humans = opts.org === undefined ? all : all.filter((h) => h.organizationId === opts.org);
  const seats = await db.select({ id: hubOperators.principalId }).from(hubOperators);
  const ids = new Set(humans.map((h) => h.id));
  return {
    totalUsers: humans.length,
    // Seat holders among those humans; never the hub-wide number for a workspace's view.
    adminUsers: seats.filter((s) => ids.has(s.id)).length,
    bannedUsers: humans.filter((h) => h.suspended).length,
    totalSandboxes: 0,
    runningSandboxes: 0,
    usersThisWeek: 0,
  };
}
