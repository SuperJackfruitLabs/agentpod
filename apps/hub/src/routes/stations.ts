/**
 * Authenticated station routes.
 *
 * All routes verify that the target node belongs to c.get("user").id before
 * brokering or querying.  Station ownership is implicit: a station row always
 * carries userId, and the registry functions scope every query to that userId.
 *
 * Mounted at /api in index.ts so paths here are relative to /api:
 *   GET    /nodes/:nodeId/detected          → detect + mark adopted
 *   POST   /nodes/:nodeId/stations/adopt    → adopt selected keys
 *   GET    /nodes/:nodeId/stations          → list adopted (flat)
 *   DELETE /stations/:stationId             → unadopt
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import * as broker from "../services/broker";
import { connectionManager } from "../services/connection-manager";
import { VERB_RESULTS } from "@agentpod/contract";
import { sniffImage } from "../utils/sniff-image";
import {
  adoptStations,
  listAdopted,
  unadopt,
  getStation,
} from "../services/station-registry";

/** The most a console file read may ask for: an image preview, not a download. */
const FILE_READ_MAX_BYTES = 8 * 1024 * 1024;

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Returns the node row if it belongs to userId, otherwise null. */
async function requireNodeOwnership(userId: string, nodeId: string) {
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)));
  return rows[0] ?? null;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const stationRoutes = new Hono()
  /**
   * GET /api/nodes/:nodeId/detected
   *
   * Sends a "detect" RPC to the live node via the broker.  Each returned
   * DetectedStation is annotated with adopted:true/false based on whether a
   * stations row already exists for (nodeId, stationKey).
   *
   * Returns 404 if the node is not owned by the requesting user.
   * Returns 502 if the node is offline, times out, or returns invalid data.
   */
  .get("/nodes/:nodeId/detected", async (c) => {
    const userId = c.get("user").id;
    const nodeId = c.req.param("nodeId");

    if (!(await requireNodeOwnership(userId, nodeId))) {
      return c.json({ error: "Not Found" }, 404);
    }

    const result = await broker.request(nodeId, "detect", {}, { timeoutMs: 10_000 });
    if (!result.ok) {
      return c.json({ error: result.error ?? "detect failed" }, 502);
    }

    const parsed = VERB_RESULTS.detect.safeParse(result.data);
    if (!parsed.success) {
      return c.json({ error: "invalid detect response from node" }, 502);
    }

    const adoptedRows = await listAdopted(userId, nodeId);
    const adoptedKeys = new Set(adoptedRows.map((s) => s.stationKey));

    return c.json(
      parsed.data.map((s) => ({ ...s, adopted: adoptedKeys.has(s.key) }))
    );
  })
  /**
   * POST /api/nodes/:nodeId/stations/adopt
   * Body: { keys: string[] }
   *
   * Re-detects server-side (for trust), then upserts the requested keys into
   * the stations table.  Returns the newly/previously adopted rows.
   */
  .post(
    "/nodes/:nodeId/stations/adopt",
    zValidator("json", z.object({ keys: z.array(z.string().min(1)) })),
    async (c) => {
      const userId = c.get("user").id;
      const nodeId = c.req.param("nodeId");
      const { keys } = c.req.valid("json");

      if (!(await requireNodeOwnership(userId, nodeId))) {
        return c.json({ error: "Not Found" }, 404);
      }

      const result = await broker.request(nodeId, "detect", {}, { timeoutMs: 10_000 });
      if (!result.ok) {
        return c.json({ error: result.error ?? "detect failed" }, 502);
      }

      const parsed = VERB_RESULTS.detect.safeParse(result.data);
      if (!parsed.success) {
        return c.json({ error: "invalid detect response from node" }, 502);
      }

      const rows = await adoptStations(userId, nodeId, keys, parsed.data);
      return c.json(rows);
    }
  )
  /**
   * GET /api/nodes/:nodeId/stations
   *
   * Returns the flat list of adopted stations for the given node.
   * The console builds the tree from parentStationId.
   */
  .get("/nodes/:nodeId/stations", async (c) => {
    const userId = c.get("user").id;
    const nodeId = c.req.param("nodeId");

    if (!(await requireNodeOwnership(userId, nodeId))) {
      return c.json({ error: "Not Found" }, 404);
    }

    return c.json(await listAdopted(userId, nodeId));
  })
  /**
   * DELETE /api/stations/:stationId
   *
   * Removes a station row.  Ownership is verified via getStation (which scopes
   * by userId).  Returns 404 if the station does not exist or belongs to a
   * different user.
   */
  .delete("/stations/:stationId", async (c) => {
    const userId = c.get("user").id;
    const stationId = c.req.param("stationId");

    const station = await getStation(userId, stationId);
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    await unadopt(userId, stationId);
    return new Response(null, { status: 204 });
  })
  /**
   * GET /api/stations/:stationId/health
   *
   * Forwards a "health" RPC to the node that owns this station.
   * Returns 404 if the station is not owned by the requesting user.
   * Returns 502 if the node is offline, times out, or returns invalid data.
   */
  .get("/stations/:stationId/health", async (c) => {
    const userId = c.get("user").id;
    const stationId = c.req.param("stationId");

    const station = await getStation(userId, stationId);
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    const result = await broker.request(station.nodeId, "health", {
      key: station.stationKey,
    });
    if (!result.ok) {
      return c.json({ error: result.error ?? "health failed" }, 502);
    }

    const parsed = VERB_RESULTS.health.safeParse(result.data);
    if (!parsed.success) {
      return c.json({ error: "invalid health response from node" }, 502);
    }

    return c.json(parsed.data);
  })
  /**
   * GET /api/stations/:stationId/files?path=<rel>
   *
   * Lists files/directories at the given path on the station's node.
   * Returns 404 if the station is not owned by the requesting user.
   * Returns 502 if the node is offline, times out, or returns invalid data.
   */
  .get(
    "/stations/:stationId/files",
    zValidator("query", z.object({ path: z.string().default(".") })),
    async (c) => {
      const userId = c.get("user").id;
      const stationId = c.req.param("stationId");
      const { path } = c.req.valid("query");

      const station = await getStation(userId, stationId);
      if (!station) {
        return c.json({ error: "Not Found" }, 404);
      }

      const result = await broker.request(station.nodeId, "fs.list", {
        key: station.stationKey,
        path,
      });
      if (!result.ok) {
        return c.json({ error: result.error ?? "fs.list failed" }, 502);
      }

      const parsed = VERB_RESULTS["fs.list"].safeParse(result.data);
      if (!parsed.success) {
        return c.json({ error: "invalid fs.list response from node" }, 502);
      }

      return c.json(parsed.data);
    }
  )
  /**
   * GET /api/stations/:stationId/file?path=<rel>
   *
   * Reads a single file from the station's node.  If the node returns
   * base64-encoded content it is decoded to bytes and returned as
   * application/octet-stream; utf8 content is returned as text/plain.
   * Sets X-Truncated: true when the node reports the file was capped.
   *
   * Returns 404 if the station is not owned by the requesting user.
   * Returns 502 if the node is offline, times out, or returns invalid data.
   */
  .get(
    "/stations/:stationId/file",
    zValidator(
      "query",
      z.object({
        path: z.string().min(1),
        // Omitted keeps the node's 1 MiB default. The console asks for more
        // to preview an image; the ceiling keeps one read's base64 frame
        // well under the broker's websocket limit.
        maxBytes: z.coerce.number().int().positive().max(FILE_READ_MAX_BYTES).optional(),
      })
    ),
    async (c) => {
      const userId = c.get("user").id;
      const stationId = c.req.param("stationId");
      const { path, maxBytes } = c.req.valid("query");

      const station = await getStation(userId, stationId);
      if (!station) {
        return c.json({ error: "Not Found" }, 404);
      }

      const result = await broker.request(station.nodeId, "fs.read", {
        key: station.stationKey,
        path,
        ...(maxBytes ? { maxBytes } : {}),
      });
      if (!result.ok) {
        return c.json({ error: result.error ?? "fs.read failed" }, 502);
      }

      const parsed = VERB_RESULTS["fs.read"].safeParse(result.data);
      if (!parsed.success) {
        return c.json({ error: "invalid fs.read response from node" }, 502);
      }

      const { content, encoding, truncated } = parsed.data;

      if (encoding === "base64") {
        const bytes = Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0));
        return new Response(bytes, {
          headers: {
            // An image says what it is so the console can show it; anything
            // else stays opaque.
            "Content-Type": sniffImage(bytes) ?? "application/octet-stream",
            "X-Truncated": String(truncated),
          },
        });
      }

      return new Response(content, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Truncated": String(truncated),
        },
      });
    }
  )
  /**
   * GET /api/stations/:stationId/logs
   *
   * Opens an SSE stream that tails the station's log output.
   * Each log chunk is forwarded as an SSE `data:` event.
   * The broker stream is cancelled when the client disconnects.
   *
   * Returns 404 if the station is not owned by the requesting user.
   * Returns 502 if the node is offline.
   */
  .get("/stations/:stationId/logs", async (c) => {
    const userId = c.get("user").id;
    const stationId = c.req.param("stationId");

    const station = await getStation(userId, stationId);
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    // Finding 1: Return 502 immediately instead of opening a dead SSE stream.
    if (!connectionManager.isOnline(station.nodeId)) {
      return c.json({ error: "node offline" }, 502);
    }

    return streamSSE(c, async (stream) => {
      let cancelled = false;

      // Finding 2: shared resolver so BOTH eof and client-abort unblock the callback.
      let resolveKeepAlive!: () => void;
      const keepAlive = new Promise<void>((r) => {
        resolveKeepAlive = r;
      });

      const { cancel } = broker.stream(
        station.nodeId,
        "logs.tail",
        { key: station.stationKey, follow: true },
        async (_seq, chunk, eof) => {
          if (cancelled) return;
          if (chunk !== null) {
            await stream.writeSSE({ data: chunk });
          }
          if (eof) {
            cancelled = true;
            resolveKeepAlive();
          }
        }
      );

      // Cancel the broker stream when the client disconnects.
      stream.onAbort(() => {
        cancelled = true;
        cancel();
        resolveKeepAlive();
      });

      // Keep the SSE handler alive until either eof or client disconnect.
      await keepAlive;
    });
  });
