/**
 * Station Activity Route
 *
 * GET /api/stations/:id/activity
 *
 * Returns the most recent station_audit rows for the given station,
 * newest first, capped at 200 rows.
 *
 * Auth: Better Auth session cookie / X-Test-User-Id in tests.
 * Ownership: the station must belong to the authenticated user.
 *
 * Mounted at /api in index.ts.
 */

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { stationAudit } from "../db/schema/audit";
import { getStation } from "../services/station-registry";
import type { AuthUser } from "../auth/middleware";
import { tenantScope } from "../db/tenant-scope";

const ACTIVITY_LIMIT = 200;

export const stationActivityRoutes = new Hono().get(
  "/stations/:id/activity",
  async (c) => {
    // ── 1. Authenticate ───────────────────────────────────────────────
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // ── 2. Station in the caller's workspace ──────────────────────────
    const stationId = c.req.param("id");
    const station = await getStation(user, stationId);
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    // ── 3. Fetch audit rows ───────────────────────────────────────────
    const rows = await db
      .select()
      .from(stationAudit)
      // The station's activity in this workspace, by whoever acted (W4).
      .where(
        tenantScope(
          stationAudit,
          user.tenantId,
          eq(stationAudit.nodeId, station.nodeId),
          eq(stationAudit.stationKey, station.stationKey)
        )
      )
      .orderBy(desc(stationAudit.createdAt))
      .limit(ACTIVITY_LIMIT);

    return c.json(rows);
  }
);
