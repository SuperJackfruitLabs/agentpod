/**
 * Station Write Routes — capability-gated, audited filesystem mutations.
 *
 * All four routes follow the same safety model:
 *   1. Authenticate (reject 401 if anonymous).
 *   2. Verify station ownership via getStation(userId, stationId) → 404 if absent.
 *   3. Capability gate: station.capabilities must include "fs.write" → 403 otherwise.
 *   4. Record a station_audit row BEFORE dispatching to the node.
 *   5. Broker.request() to the node.
 *   6. Finalise the audit row with the result.
 *   7. Respond.
 *
 * Node-offline is surfaced as 409 (the node is reachable in principle but
 * currently disconnected — a transient conflict, not a permanent error).
 *
 * Params sanitisation: only path/from/to/encoding/backup/recursive are stored
 * in the audit row — file CONTENT is NEVER persisted.
 *
 * Mounted at /api in index.ts so all paths here are relative to /api:
 *   POST /stations/:id/fs/write
 *   POST /stations/:id/fs/mkdir
 *   POST /stations/:id/fs/move
 *   POST /stations/:id/fs/delete
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Capability } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { requireGrantReach } from "../services/grant-reach";
import { isGrantReachDenied } from "../services/control-pair";
import * as broker from "../services/broker";
import { getStation } from "../services/station-registry";
import { recordAudit } from "../services/audit";
import type { AuthUser } from "../auth/middleware";
import type { StationRow } from "../services/station-registry";

// ─── Capability helper ────────────────────────────────────────────────────────

/**
 * Returns true if the station's capabilities array includes the given cap.
 *
 * Called gateCapability because it is used as a gate: the caller returns 403
 * immediately if this returns false.
 */
export function gateCapability(station: StationRow, cap: string): boolean {
  return Array.isArray(station.capabilities) && station.capabilities.includes(cap);
}

// ─── Reach gate ───────────────────────────────────────────────────────────────

/**
 * Refuse a mutation the principal may not make, or return null to continue.
 *
 * A sibling of `gateCapability` rather than part of it: that function is called
 * for reads too (`changeset/status`, `cleanup/plan`), and a check inside it
 * would refuse someone permission to look at a diff, which is nobody's idea of
 * granting reach.
 *
 * The refusal is audited as well as logged. An attempt refused and recorded
 * nowhere is indistinguishable from an attempt nobody made, which is precisely
 * what an operator reading the activity trail is trying to tell apart.
 */
export async function refuseWithoutReach(
  c: Context,
  userId: string,
  station: StationRow,
  cap: Capability
): Promise<Response | null> {
  try {
    await requireGrantReach(userId, station, cap, "mutate");
    return null;
  } catch (e) {
    if (!isGrantReachDenied(e)) throw e;

    const audit = await recordAudit(db, {
      userId,
      nodeId: station.nodeId,
      stationKey: station.stationKey,
      verb: cap,
      params: { refused: "grant-reach" },
    });
    await audit.done("error", "refused by the control pair");

    return c.json({ error: e.message }, 403);
  }
}

// ─── Error-to-status helper ───────────────────────────────────────────────────

/**
 * Maps broker error strings to HTTP status codes.
 * "node offline" / "node disconnected" → 409 (transient conflict).
 * Everything else → 502 (upstream failure).
 */
function brokerErrorStatus(error: string | undefined): 409 | 502 {
  if (error === "node offline" || error === "node disconnected") return 409;
  return 502;
}

// ─── Shared auth + ownership guard ───────────────────────────────────────────

type RouteContext = {
  user: AuthUser | undefined;
};

// ─── Route schemas ────────────────────────────────────────────────────────────

const WriteBody = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  backup: z.boolean().optional(),
});

const MkdirBody = z.object({
  path: z.string().min(1),
});

const MoveBody = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

const DeleteBody = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export const stationWriteRoutes = new Hono()

  /**
   * POST /api/stations/:id/fs/write
   *
   * Body: { path, content, encoding, backup? }
   * Writes a file to the station's workspace.  The "content" field is NEVER
   * stored in the audit log — only "path", "encoding", and "backup" are.
   */
  .post(
    "/stations/:id/fs/write",
    zValidator("json", WriteBody),
    async (c) => {
      // ── 1. Authenticate ─────────────────────────────────────────────────────
      const user = c.get("user") as AuthUser | undefined;
      if (!user || user.id === "anonymous") {
        return c.json({ error: "Unauthorized" }, 401);
      }

      // ── 2. Ownership check ──────────────────────────────────────────────────
      const stationId = c.req.param("id");
      const station = await getStation(user.id, stationId);
      if (!station) {
        return c.json({ error: "Not Found" }, 404);
      }

      // ── 3. Capability gate ──────────────────────────────────────────────────
      if (!gateCapability(station, "fs.write")) {
        return c.json(
          { error: "Forbidden: station does not advertise fs.write capability" },
          403
        );
      }

      // ── 3b. Reach gate ──────────────────────────────────────────────────────
      // Writing into a workspace is how an agent acquires credentials it did
      // not have, so this is the second half of the control pair, not a repeat
      // of the first: dispatch permission is not permission to rewrite.
      //
      // After the capability gate on purpose — "this station cannot" and "you
      // may not" send an operator to different places.
      const denial = await refuseWithoutReach(c, user.id, station, "fs.write");
      if (denial) return denial;

      const body = c.req.valid("json");

      // ── 4. Audit (safe params only — no content) ────────────────────────────
      const audit = await recordAudit(db, {
        userId: user.id,
        nodeId: station.nodeId,
        stationKey: station.stationKey,
        verb: "fs.write",
        params: {
          path: body.path,
          encoding: body.encoding,
          backup: body.backup,
        },
      });

      // ── 5. Broker request ───────────────────────────────────────────────────
      const result = await broker.request(station.nodeId, "fs.write", {
        key: station.stationKey,
        path: body.path,
        content: body.content,
        encoding: body.encoding,
        backup: body.backup,
      });

      // ── 6. Finalise audit ───────────────────────────────────────────────────
      await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

      // ── 7. Respond ──────────────────────────────────────────────────────────
      if (!result.ok) {
        return c.json(
          { error: result.error ?? "fs.write failed" },
          brokerErrorStatus(result.error)
        );
      }

      return c.json(result.data);
    }
  )

  /**
   * POST /api/stations/:id/fs/mkdir
   *
   * Body: { path }
   * Creates a directory (and any missing parents) on the station's workspace.
   */
  .post(
    "/stations/:id/fs/mkdir",
    zValidator("json", MkdirBody),
    async (c) => {
      // ── 1. Authenticate ─────────────────────────────────────────────────────
      const user = c.get("user") as AuthUser | undefined;
      if (!user || user.id === "anonymous") {
        return c.json({ error: "Unauthorized" }, 401);
      }

      // ── 2. Ownership check ──────────────────────────────────────────────────
      const stationId = c.req.param("id");
      const station = await getStation(user.id, stationId);
      if (!station) {
        return c.json({ error: "Not Found" }, 404);
      }

      // ── 3. Capability gate ──────────────────────────────────────────────────
      if (!gateCapability(station, "fs.write")) {
        return c.json(
          { error: "Forbidden: station does not advertise fs.write capability" },
          403
        );
      }

      // ── 3b. Reach gate ──────────────────────────────────────────────────────
      // Writing into a workspace is how an agent acquires credentials it did
      // not have, so this is the second half of the control pair, not a repeat
      // of the first: dispatch permission is not permission to rewrite.
      //
      // After the capability gate on purpose — "this station cannot" and "you
      // may not" send an operator to different places.
      const denial = await refuseWithoutReach(c, user.id, station, "fs.write");
      if (denial) return denial;

      const body = c.req.valid("json");

      // ── 4. Audit ────────────────────────────────────────────────────────────
      const audit = await recordAudit(db, {
        userId: user.id,
        nodeId: station.nodeId,
        stationKey: station.stationKey,
        verb: "fs.mkdir",
        params: { path: body.path },
      });

      // ── 5. Broker request ───────────────────────────────────────────────────
      const result = await broker.request(station.nodeId, "fs.mkdir", {
        key: station.stationKey,
        path: body.path,
      });

      // ── 6. Finalise audit ───────────────────────────────────────────────────
      await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

      // ── 7. Respond ──────────────────────────────────────────────────────────
      if (!result.ok) {
        return c.json(
          { error: result.error ?? "fs.mkdir failed" },
          brokerErrorStatus(result.error)
        );
      }

      return c.json(result.data);
    }
  )

  /**
   * POST /api/stations/:id/fs/move
   *
   * Body: { from, to }
   * Moves (renames) a file or directory within the station's workspace.
   */
  .post(
    "/stations/:id/fs/move",
    zValidator("json", MoveBody),
    async (c) => {
      // ── 1. Authenticate ─────────────────────────────────────────────────────
      const user = c.get("user") as AuthUser | undefined;
      if (!user || user.id === "anonymous") {
        return c.json({ error: "Unauthorized" }, 401);
      }

      // ── 2. Ownership check ──────────────────────────────────────────────────
      const stationId = c.req.param("id");
      const station = await getStation(user.id, stationId);
      if (!station) {
        return c.json({ error: "Not Found" }, 404);
      }

      // ── 3. Capability gate ──────────────────────────────────────────────────
      if (!gateCapability(station, "fs.write")) {
        return c.json(
          { error: "Forbidden: station does not advertise fs.write capability" },
          403
        );
      }

      // ── 3b. Reach gate ──────────────────────────────────────────────────────
      // Writing into a workspace is how an agent acquires credentials it did
      // not have, so this is the second half of the control pair, not a repeat
      // of the first: dispatch permission is not permission to rewrite.
      //
      // After the capability gate on purpose — "this station cannot" and "you
      // may not" send an operator to different places.
      const denial = await refuseWithoutReach(c, user.id, station, "fs.write");
      if (denial) return denial;

      const body = c.req.valid("json");

      // ── 4. Audit ────────────────────────────────────────────────────────────
      const audit = await recordAudit(db, {
        userId: user.id,
        nodeId: station.nodeId,
        stationKey: station.stationKey,
        verb: "fs.move",
        params: { from: body.from, to: body.to },
      });

      // ── 5. Broker request ───────────────────────────────────────────────────
      const result = await broker.request(station.nodeId, "fs.move", {
        key: station.stationKey,
        from: body.from,
        to: body.to,
      });

      // ── 6. Finalise audit ───────────────────────────────────────────────────
      await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

      // ── 7. Respond ──────────────────────────────────────────────────────────
      if (!result.ok) {
        return c.json(
          { error: result.error ?? "fs.move failed" },
          brokerErrorStatus(result.error)
        );
      }

      return c.json(result.data);
    }
  )

  /**
   * POST /api/stations/:id/fs/delete
   *
   * Body: { path, recursive? }
   * Deletes a file or directory on the station's workspace.
   * Non-recursive delete of a non-empty directory will error at the node.
   */
  .post(
    "/stations/:id/fs/delete",
    zValidator("json", DeleteBody),
    async (c) => {
      // ── 1. Authenticate ─────────────────────────────────────────────────────
      const user = c.get("user") as AuthUser | undefined;
      if (!user || user.id === "anonymous") {
        return c.json({ error: "Unauthorized" }, 401);
      }

      // ── 2. Ownership check ──────────────────────────────────────────────────
      const stationId = c.req.param("id");
      const station = await getStation(user.id, stationId);
      if (!station) {
        return c.json({ error: "Not Found" }, 404);
      }

      // ── 3. Capability gate ──────────────────────────────────────────────────
      if (!gateCapability(station, "fs.write")) {
        return c.json(
          { error: "Forbidden: station does not advertise fs.write capability" },
          403
        );
      }

      // ── 3b. Reach gate ──────────────────────────────────────────────────────
      // Writing into a workspace is how an agent acquires credentials it did
      // not have, so this is the second half of the control pair, not a repeat
      // of the first: dispatch permission is not permission to rewrite.
      //
      // After the capability gate on purpose — "this station cannot" and "you
      // may not" send an operator to different places.
      const denial = await refuseWithoutReach(c, user.id, station, "fs.write");
      if (denial) return denial;

      const body = c.req.valid("json");

      // ── 4. Audit ────────────────────────────────────────────────────────────
      const audit = await recordAudit(db, {
        userId: user.id,
        nodeId: station.nodeId,
        stationKey: station.stationKey,
        verb: "fs.delete",
        params: { path: body.path, recursive: body.recursive },
      });

      // ── 5. Broker request ───────────────────────────────────────────────────
      const result = await broker.request(station.nodeId, "fs.delete", {
        key: station.stationKey,
        path: body.path,
        recursive: body.recursive,
      });

      // ── 6. Finalise audit ───────────────────────────────────────────────────
      await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

      // ── 7. Respond ──────────────────────────────────────────────────────────
      if (!result.ok) {
        return c.json(
          { error: result.error ?? "fs.delete failed" },
          brokerErrorStatus(result.error)
        );
      }

      return c.json(result.data);
    }
  );
