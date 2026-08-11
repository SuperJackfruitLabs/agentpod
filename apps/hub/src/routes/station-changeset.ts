/**
 * Station Changeset Routes — POST /api/stations/:id/changeset/status
 *                            POST /api/stations/:id/changeset/diff
 *
 * Safety model (mirrors station-cleanup.ts):
 *   1. Authenticate (401 if anonymous).
 *   2. Station ownership via getStation → 404 if absent.
 *   3. Capability gate: requires "changeset" → 403 if absent (no node call).
 *   4. broker.request() to the node.
 *   5. Respond.
 *
 * Node-offline → 409; other broker errors → 502.
 *
 * `diff` records an audit row and `status` does not. Status is fetched every
 * time the panel opens and on every refresh, so auditing it would bury the log
 * in noise; the diff is where source code actually leaves the machine, and that
 * is the event worth a record.
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

// ─── Error-to-status helper ───────────────────────────────────────────────────

function brokerErrorStatus(error: string | undefined): 409 | 502 {
  if (error === "node offline" || error === "node disconnected") return 409;
  return 502;
}

// ─── Route schemas ────────────────────────────────────────────────────────────

const StatusBody = z.object({
  base: z.string().min(1).optional(),
});

const DiffBody = z.object({
  side: z.enum(["uncommitted", "committed"]),
  path: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
  maxBytes: z.number().int().positive().max(8 << 20).optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export const stationChangesetRoutes = new Hono()

  /**
   * POST /api/stations/:id/changeset/status
   *
   * Returns the summary: repo, the base and WHY it was chosen, and the
   * uncommitted and committed sides kept separate.
   */
  .post("/stations/:id/changeset/status", zValidator("json", StatusBody), async (c) => {
    // ── 1. Authenticate ──────────────────────────────────────────────────────
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // ── 2. Ownership check ───────────────────────────────────────────────────
    const station = await getStation(user.id, c.req.param("id"));
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    // ── 3. Capability gate (before any node call) ────────────────────────────
    if (!gateCapability(station, "changeset")) {
      return c.json(
        { error: "Forbidden: station does not advertise changeset capability" },
        403
      );
    }

    // ── 4. Broker request ────────────────────────────────────────────────────
    // `base` is spread in only when present: the node reads an absent base as
    // "choose one for me", and an explicit null would read as an explicit base.
    const { base } = c.req.valid("json");
    const result = await broker.request(station.nodeId, "changeset.status", {
      key: station.stationKey,
      ...(base ? { base } : {}),
    });

    // ── 5. Respond ───────────────────────────────────────────────────────────
    if (!result.ok) {
      return c.json(
        { error: result.error ?? "changeset.status failed" },
        brokerErrorStatus(result.error)
      );
    }
    return c.json(result.data);
  })

  /**
   * POST /api/stations/:id/changeset/diff
   *
   * Body: { side, path?, base?, maxBytes? }
   * Returns { content, truncated, binary } — the fs.read truncation contract.
   */
  .post("/stations/:id/changeset/diff", zValidator("json", DiffBody), async (c) => {
    // ── 1. Authenticate ──────────────────────────────────────────────────────
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // ── 2. Ownership check ───────────────────────────────────────────────────
    const station = await getStation(user.id, c.req.param("id"));
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    // ── 3. Capability gate ───────────────────────────────────────────────────
    if (!gateCapability(station, "changeset")) {
      return c.json(
        { error: "Forbidden: station does not advertise changeset capability" },
        403
      );
    }

    const { side, path, base, maxBytes } = c.req.valid("json");

    // ── 4. Audit — this is the call that moves source off the machine ────────
    const audit = await recordAudit(db, {
      userId: user.id,
      nodeId: station.nodeId,
      stationKey: station.stationKey,
      verb: "changeset.diff",
      params: { side, path: path ?? null },
    });

    // ── 5. Broker request ────────────────────────────────────────────────────
    const result = await broker.request(station.nodeId, "changeset.diff", {
      key: station.stationKey,
      side,
      ...(path ? { path } : {}),
      ...(base ? { base } : {}),
      ...(maxBytes ? { maxBytes } : {}),
    });

    // ── 6. Finalise audit ────────────────────────────────────────────────────
    await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

    // ── 7. Respond ───────────────────────────────────────────────────────────
    if (!result.ok) {
      return c.json(
        { error: result.error ?? "changeset.diff failed" },
        brokerErrorStatus(result.error)
      );
    }
    return c.json(result.data);
  });
