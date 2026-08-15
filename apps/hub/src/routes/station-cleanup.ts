/**
 * Station Cleanup Routes — POST /api/stations/:id/cleanup/plan
 *                          POST /api/stations/:id/cleanup/apply
 *
 * Safety model (mirrors station-writes.ts / station-lifecycle.ts):
 *   1. Authenticate (401 if anonymous).
 *   2. Station ownership via getStation → 404 if absent.
 *   3. Capability gate: requires "cleanup" → 403 if absent (no node call).
 *   4. Record a station_audit row BEFORE dispatching.
 *   5. broker.request() to the node.
 *   6. Finalise audit row.
 *   7. Respond.
 *
 * Node-offline → 409; other broker errors → 502.
 *
 * Mounted at /api so paths here are relative to /api:
 *   POST /stations/:id/cleanup/plan
 *   POST /stations/:id/cleanup/apply
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db/drizzle";
import * as broker from "../services/broker";
import { getStation } from "../services/station-registry";
import { recordAudit } from "../services/audit";
import { gateCapability, refuseWithoutReach } from "./station-writes";
import type { AuthUser } from "../auth/middleware";

// ─── Error-to-status helper ───────────────────────────────────────────────────

function brokerErrorStatus(error: string | undefined): 409 | 502 {
  if (error === "node offline" || error === "node disconnected") return 409;
  return 502;
}

// ─── Route schemas ────────────────────────────────────────────────────────────

const ApplyBody = z.object({
  paths: z.array(z.string()).min(1),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export const stationCleanupRoutes = new Hono()

  /**
   * POST /api/stations/:id/cleanup/plan
   *
   * Returns { items: [{path,size,kind}], totalBytes }.
   */
  .post("/stations/:id/cleanup/plan", async (c) => {
    // ── 1. Authenticate ──────────────────────────────────────────────────────
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // ── 2. Ownership check ───────────────────────────────────────────────────
    const stationId = c.req.param("id");
    const station = await getStation(user.id, stationId);
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    // ── 3. Capability gate ───────────────────────────────────────────────────
    if (!gateCapability(station, "cleanup")) {
      return c.json(
        { error: "Forbidden: station does not advertise cleanup capability" },
        403
      );
    }

    // ── 4. Audit ─────────────────────────────────────────────────────────────
    const audit = await recordAudit(db, {
      userId: user.id,
      nodeId: station.nodeId,
      stationKey: station.stationKey,
      verb: "cleanup.plan",
      params: {},
    });

    // ── 5. Broker request ────────────────────────────────────────────────────
    const result = await broker.request(station.nodeId, "cleanup.plan", {
      key: station.stationKey,
    });

    // ── 6. Finalise audit ────────────────────────────────────────────────────
    await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

    // ── 7. Respond ───────────────────────────────────────────────────────────
    if (!result.ok) {
      return c.json(
        { error: result.error ?? "cleanup.plan failed" },
        brokerErrorStatus(result.error)
      );
    }

    return c.json(result.data);
  })

  /**
   * POST /api/stations/:id/cleanup/apply
   *
   * Body: { paths: string[] }
   * Returns { removedBytes: number }.
   * The node double-checks: re-jails each path and intersects with the current
   * plan (off-plan paths are silently skipped at the node).
   */
  .post(
    "/stations/:id/cleanup/apply",
    zValidator("json", ApplyBody),
    async (c) => {
      // ── 1. Authenticate ────────────────────────────────────────────────────
      const user = c.get("user") as AuthUser | undefined;
      if (!user || user.id === "anonymous") {
        return c.json({ error: "Unauthorized" }, 401);
      }

      // ── 2. Ownership check ─────────────────────────────────────────────────
      const stationId = c.req.param("id");
      const station = await getStation(user.id, stationId);
      if (!station) {
        return c.json({ error: "Not Found" }, 404);
      }

      // ── 3. Capability gate ─────────────────────────────────────────────────
      if (!gateCapability(station, "cleanup")) {
        return c.json(
          { error: "Forbidden: station does not advertise cleanup capability" },
          403
        );
      }

      // ── 3b. Reach gate (#345) ──────────────────────────────────────────────
      // `plan` above shares this capability and is a read; deleting an agent's
      // files is not. So the split is on the route's effect, not the capability
      // word — guarding the word would refuse someone permission to find out
      // what a cleanup would remove.
      const denial = await refuseWithoutReach(c, user.id, station, "cleanup");
      if (denial) return denial;

      const { paths } = c.req.valid("json");

      // ── 4. Audit (path count only — never the full list if large) ──────────
      const audit = await recordAudit(db, {
        userId: user.id,
        nodeId: station.nodeId,
        stationKey: station.stationKey,
        verb: "cleanup.apply",
        params: { pathCount: paths.length, paths: paths.length <= 20 ? paths : undefined },
      });

      // ── 5. Broker request ──────────────────────────────────────────────────
      const result = await broker.request(station.nodeId, "cleanup.apply", {
        key: station.stationKey,
        paths,
      });

      // ── 6. Finalise audit ──────────────────────────────────────────────────
      await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

      // ── 7. Respond ─────────────────────────────────────────────────────────
      if (!result.ok) {
        return c.json(
          { error: result.error ?? "cleanup.apply failed" },
          brokerErrorStatus(result.error)
        );
      }

      return c.json(result.data);
    }
  );
