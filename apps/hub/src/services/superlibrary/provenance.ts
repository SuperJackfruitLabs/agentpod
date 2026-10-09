import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { bridgeAgents, bridgeDispatches } from "../../db/schema/bridge";
import type { LinkProvenance } from "./link";

const NO_BOARD = "This station is not on exactly one board, so the file has nowhere to belong. Link it while working a card.";
/** A dispatch the agent is still on: claimed and working, or produced and not yet reported. */
const OPEN = ["working", "produced"] as const;

/**
 * Plan P3: where a file linked from this station belongs. The station's newest open dispatch gives
 * board, card and run; else the station's one enabled board (no card, no run); else nothing, and
 * the link is refused. Only this station's rows in this tenant are ever read.
 */
export async function stationProvenance(stationId: string, tenantId: string): Promise<LinkProvenance> {
  const [open] = await db
    .select({ boardId: bridgeDispatches.boardId, cardId: bridgeDispatches.externalCardId, runId: bridgeDispatches.externalRunId })
    .from(bridgeDispatches)
    .where(and(eq(bridgeDispatches.stationId, stationId), eq(bridgeDispatches.tenantId, tenantId), inArray(bridgeDispatches.outcome, [...OPEN])))
    .orderBy(desc(bridgeDispatches.startedAt))
    .limit(1);
  if (open) return { board: open.boardId, card: open.cardId, run: open.runId };
  const rows = await db
    .selectDistinct({ boardId: bridgeAgents.boardId })
    .from(bridgeAgents)
    .where(and(eq(bridgeAgents.stationId, stationId), eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.enabled, true)));
  return rows.length === 1 ? { board: rows[0]!.boardId } : { refused: NO_BOARD };
}
