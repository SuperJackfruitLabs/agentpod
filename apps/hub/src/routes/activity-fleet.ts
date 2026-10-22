/**
 * Fleet Activity Route
 *
 * GET /api/activity
 *
 * Returns the workspace's most recent station_audit rows across all its
 * stations (fleet-wide), newest first, capped at 30 rows. The fleet is the
 * workspace's (workspace authority spec, W4), so is what happened on it.
 *
 * Rows are already sanitized at insert time (paramsSummary only —
 * no raw content or tokens). No additional scrubbing is needed here.
 *
 * Auth: Better Auth session cookie / X-Test-User-Id in tests.
 * Scoping: the request's tenant.
 *
 * Mounted at /api in index.ts → resolves to GET /api/activity.
 */

import { Hono } from "hono";
import { desc } from "drizzle-orm";
import { db } from "../db/drizzle";
import { stationAudit } from "../db/schema/audit";
import type { AuthUser } from "../auth/middleware";
import { tenantScope } from "../db/tenant-scope";

const FLEET_ACTIVITY_LIMIT = 30;

export const fleetActivityRoutes = new Hono().get("/activity", async (c) => {
  // ── 1. Authenticate ────────────────────────────────────────────────────
  const user = c.get("user") as AuthUser | undefined;
  if (!user || user.id === "anonymous") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // ── 2. Fetch fleet-wide audit rows for this workspace ───────────────────
  const rows = await db
    .select()
    .from(stationAudit)
    .where(tenantScope(stationAudit, user.tenantId))
    .orderBy(desc(stationAudit.createdAt))
    .limit(FLEET_ACTIVITY_LIMIT);

  return c.json(rows);
});
