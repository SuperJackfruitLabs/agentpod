/**
 * Saying what a station is for.
 *
 * The fleet is laid out by use case — personal agents on one node, work agents
 * on another, the rest ad hoc — and until now that fact lived nowhere but in
 * the operator's head and, by coincidence, in the node names. It is scheduled
 * to stop being a coincidence: coming use cases span harnesses and runtimes,
 * and one node will host more than one of them.
 *
 * So purpose is a field. It lives on the **station** — the node's is only the
 * default applied at adoption (`station-registry.adoptStations`) — and setting
 * it re-files the station's room under that purpose's Matrix space, which is
 * how a roster of a hundred agents stays readable.
 *
 * Setting a NODE's purpose also labels the stations on it that have none. That
 * is not a surprise reaching into the station's business: null means nobody has
 * said, and the whole point of the node's field is to answer for the ones
 * nobody has answered for. It is what makes an existing fleet adoptable without
 * clicking through it station by station — and it is reported in the response
 * rather than done quietly.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { nodes } from "../db/schema/nodes";
import { notifyStationsAdopted } from "../services/matrix-as/hooks";
import { createLogger } from "../utils/logger";

const log = createLogger("purpose");

/**
 * A purpose is a label an operator types, so it is bounded and trimmed, and
 * the empty string is not a purpose — it is the absence of one, which is
 * spelled `null` everywhere else and gets spelled `null` here too.
 */
const PurposeBody = z.object({
  purpose: z
    .string()
    .max(64)
    .nullable()
    .transform((value) => {
      if (value === null) return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    }),
});

export const purposeRoutes = new Hono()
  /**
   * PUT /api/stations/:stationId/purpose
   * Body: { purpose: string | null }
   *
   * `null` unlabels it, which files it under no space at all — it goes back to
   * appearing only in All rooms, which is where an unlabelled station belongs.
   */
  .put(
    "/stations/:stationId/purpose",
    zValidator("json", PurposeBody),
    async (c) => {
      const userId = c.get("user").id;
      const stationId = c.req.param("stationId");
      const { purpose } = c.req.valid("json");

      const updated = await db
        .update(stations)
        .set({ purpose })
        .where(and(eq(stations.id, stationId), eq(stations.userId, userId)))
        .returning({ id: stations.id, purpose: stations.purpose });

      const row = updated[0];
      if (!row) return c.json({ error: "Not Found" }, 404);

      log.info("station purpose set", { stationId, purpose });

      // Re-filing is provisioning's job, and provisioning is idempotent — the
      // same announcement adoption makes. One reconciler for a station's whole
      // Matrix presence beats a second path that only knows about spaces.
      notifyStationsAdopted([row.id]);

      return c.json(row);
    }
  )
  /**
   * PUT /api/nodes/:nodeId/purpose
   * Body: { purpose: string | null }
   *
   * Sets the default future adoptions on this node inherit, and labels the
   * stations already on it that have none.
   */
  .put("/nodes/:nodeId/purpose", zValidator("json", PurposeBody), async (c) => {
    const userId = c.get("user").id;
    const nodeId = c.req.param("nodeId");
    const { purpose } = c.req.valid("json");

    const updatedNode = await db
      .update(nodes)
      .set({ purpose })
      .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
      .returning({ id: nodes.id, purpose: nodes.purpose });

    if (!updatedNode[0]) return c.json({ error: "Not Found" }, 404);

    // Only the ones nobody has answered for. A station that carries a purpose
    // of its own is not waiting for the node to supply one, and overwriting it
    // here would make "purpose lives on the station" false in the one moment
    // an operator is most likely to be reorganising.
    const labelled =
      purpose === null
        ? []
        : await db
            .update(stations)
            .set({ purpose })
            .where(and(eq(stations.nodeId, nodeId), isNull(stations.purpose)))
            .returning({ id: stations.id });

    log.info("node purpose set", {
      nodeId,
      purpose,
      stationsLabelled: labelled.length,
    });

    if (labelled.length > 0) notifyStationsAdopted(labelled.map((s) => s.id));

    return c.json({
      id: nodeId,
      purpose,
      // Named rather than counted silently: this endpoint touched rows the
      // caller did not name, and the number is how they find out.
      stationsLabelled: labelled.length,
    });
  });
