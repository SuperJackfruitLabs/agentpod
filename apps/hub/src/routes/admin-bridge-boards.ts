/**
 * Per-board bridge settings, as an operator surface.
 *
 * One switch today: `relatedWork`, the card prompt's "Related prior work" section (Superlibrary
 * spec §10). On by default for every board, so this route exists to turn it off for a board whose
 * cards should be worked without earlier work in view, and back on again.
 *
 * Mounted inside the same admin guard as `/api/admin/bridge/agents`: what a claimed card's prompt
 * carries is workspace administration. The next claim on the board reads the new value; no loop
 * restarts.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { resolveTenantForUser } from "../auth/tenant";
import { db } from "../db/drizzle";
import { bridgeBoardSettings } from "../db/schema/bridge";

/** superpipeline's own id grammar, matched here so a typo is a 400 rather than a row nobody reads. */
const BOARD_ID = /^brd_[0-9a-f]{16}$/;

export const adminBridgeBoardsRouter = new Hono().put(
  "/:boardId",
  zValidator("json", z.object({ relatedWork: z.boolean() }).strict()),
  async (c) => {
    const boardId = c.req.param("boardId");
    if (!BOARD_ID.test(boardId)) return c.json({ error: "a superpipeline board id looks like brd_<16 hex>" }, 400);
    const tenantId = await resolveTenantForUser(c.get("user")!.id);
    const { relatedWork } = c.req.valid("json");
    await db
      .insert(bridgeBoardSettings)
      .values({ tenantId, boardId, relatedWork })
      .onConflictDoUpdate({
        target: [bridgeBoardSettings.tenantId, bridgeBoardSettings.boardId],
        set: { relatedWork, updatedAt: new Date() },
      });
    return c.json({ boardId, relatedWork });
  },
);
