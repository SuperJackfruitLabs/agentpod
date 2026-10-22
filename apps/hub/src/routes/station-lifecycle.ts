/**
 * Station Lifecycle Route — POST /api/stations/:id/lifecycle
 *
 * Safety model (mirrors station-writes.ts):
 *   1. Authenticate (401 if anonymous).
 *   2. Station ownership via getStation → 404 if absent.
 *   3. Capability gate: requires "lifecycle" → 403 if absent (no node call).
 *   4. Record a station_audit row BEFORE dispatching.
 *   5. broker.request() to the node.
 *   6. Finalise audit row.
 *   7. Respond with post-action StationHealth.
 *
 * Node-offline → 409; other broker errors → 502.
 *
 * Mounted at /api so paths here are relative to /api:
 *   POST /stations/:id/lifecycle
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db/drizzle";
import * as broker from "../services/broker";
import { getStation } from "../services/station-registry";
import { recordAudit } from "../services/audit";
import { gateCapability } from "./station-writes";
import type { AuthUser } from "../auth/middleware";
import { requireWorkspaceAdmin } from "../auth/workspace-authority";

// ─── Error-to-status helper ───────────────────────────────────────────────────

function brokerErrorStatus(error: string | undefined): 409 | 502 {
  if (error === "node offline" || error === "node disconnected") return 409;
  return 502;
}

// ─── Route schema ─────────────────────────────────────────────────────────────

const LifecycleBody = z.object({
  action: z.enum(["start", "stop", "restart"]),
});

// ─── Route ───────────────────────────────────────────────────────────────────

export const stationLifecycleRoutes = new Hono()

  /**
   * POST /api/stations/:id/lifecycle
   *
   * Body: { action: "start" | "stop" | "restart" }
   * Returns the post-action StationHealth from the node.
   */
  .post(
    "/stations/:id/lifecycle",
    zValidator("json", LifecycleBody),
    async (c) => {
      // ── 1. Authenticate ─────────────────────────────────────────────────────
      const user = c.get("user") as AuthUser | undefined;
      if (!user || user.id === "anonymous") {
        return c.json({ error: "Unauthorized" }, 401);
      }

      // ── 2. Station in the caller's workspace ────────────────────────────────
      const stationId = c.req.param("id");
      // Changes the station for everyone in the workspace: a workspace admin's (W1).
      const notAdmin = requireWorkspaceAdmin(c);
      if (notAdmin) return notAdmin;
      const station = await getStation(user, stationId);
      if (!station) {
        return c.json({ error: "Not Found" }, 404);
      }

      // ── 3. Capability gate ──────────────────────────────────────────────────
      if (!gateCapability(station, "lifecycle")) {
        return c.json(
          { error: "Forbidden: station does not advertise lifecycle capability" },
          403
        );
      }

      const { action } = c.req.valid("json");

      // ── 4. Audit (only the action, never any secrets) ───────────────────────
      const audit = await recordAudit(db, {
        tenantId: station.tenantId,
        userId: user.id,
        nodeId: station.nodeId,
        stationKey: station.stationKey,
        verb: "lifecycle",
        params: { action },
      });

      // ── 5. Broker request ───────────────────────────────────────────────────
      const result = await broker.request(station.nodeId, "lifecycle", {
        key: station.stationKey,
        action,
      });

      // ── 6. Finalise audit ───────────────────────────────────────────────────
      await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

      // ── 7. Respond ──────────────────────────────────────────────────────────
      if (!result.ok) {
        return c.json(
          { error: result.error ?? "lifecycle action failed" },
          brokerErrorStatus(result.error)
        );
      }

      return c.json(result.data);
    }
  );
