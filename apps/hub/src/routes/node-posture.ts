/**
 * Node Posture Route — POST /api/nodes/:id/posture/scan
 *
 * Node-level rather than station-level: credential files live in a user's home
 * and a listening socket belongs to a process, so one scan describes one
 * machine. Findings that belong to a station carry `station`, and the console
 * joins on that rather than re-running anything per station.
 *
 * Safety model (mirrors station-cleanup.ts, with node ownership in place of
 * station ownership):
 *   1. Authenticate (401 if anonymous).
 *   2. Node ownership → 404 if absent or not owned.
 *   3. Capability gate: node must advertise "posture" → 403, no node call.
 *   4. Record an audit row.
 *   5. broker.request().
 *   6. Finalise audit, respond.
 *
 * Node-offline → 409; other broker errors → 502.
 *
 * Audited because a posture report names credential file paths. It is a
 * deliberate click rather than a poll, so it does not flood the log.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import * as broker from "../services/broker";
import { recordAudit } from "../services/audit";
import type { AuthUser } from "../auth/middleware";

// ─── Error-to-status helper ───────────────────────────────────────────────────

function brokerErrorStatus(error: string | undefined): 409 | 502 {
  if (error === "node offline" || error === "node disconnected") return 409;
  return 502;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const nodePostureRoutes = new Hono().post(
  "/nodes/:id/posture/scan",
  async (c) => {
    // ── 1. Authenticate ────────────────────────────────────────────────────
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // ── 2. Ownership check ─────────────────────────────────────────────────
    const nodeId = c.req.param("id");
    const rows = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.userId, user.id)));
    const node = rows[0];
    if (!node) {
      return c.json({ error: "Not Found" }, 404);
    }

    // ── 3. Capability gate (before any node call) ──────────────────────────
    if (
      !Array.isArray(node.capabilities) ||
      !node.capabilities.includes("posture")
    ) {
      return c.json(
        { error: "Forbidden: node does not advertise posture capability" },
        403
      );
    }

    // ── 4. Audit ───────────────────────────────────────────────────────────
    // stationKey is "" because this is not about a station. Station keys are
    // `.min(1)` in the contract, so an empty string can never collide with one.
    const audit = await recordAudit(db, {
      userId: user.id,
      nodeId: node.id,
      stationKey: "",
      verb: "posture.scan",
      params: {},
    });

    // ── 5. Broker request ──────────────────────────────────────────────────
    const result = await broker.request(node.id, "posture.scan", {});

    // ── 6. Finalise audit ──────────────────────────────────────────────────
    await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

    // ── 7. Respond ─────────────────────────────────────────────────────────
    if (!result.ok) {
      return c.json(
        { error: result.error ?? "posture.scan failed" },
        brokerErrorStatus(result.error)
      );
    }
    return c.json(result.data);
  }
);
