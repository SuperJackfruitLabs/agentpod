/**
 * Boot reconciliation and orphaned-process cleanup: what a hub restart left behind, closed once
 * its node can be reached.
 */

import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { stations } from "../../db/schema/stations";
import * as broker from "../broker";
import { connectionManager } from "../broker";
import { appendEndedState } from "./events";
import { log } from "./log";
import { restoreSalaamRow } from "./recovery";
import { isNodeSessionIdLive } from "./session-state";

/**
 * Boot reconciliation: mark all non-ended sessions ended("hub restarted");
 * best-effort acp.close each orphaned nodeSessionId whose node is online at
 * boot (log the rest). Each row's OWN node_session_id is closed — several rows
 * on one station now mean several distinct agent processes. Call from index.ts
 * boot after initDatabase.
 */
export async function reconcileOnBoot(): Promise<void> {
  const stale = await db
    .select()
    .from(acpSessions)
    .where(ne(acpSessions.status, "ended"));

  for (const row of stale) {
    if (row.executionAuthority) {
      await restoreSalaamRow(row);
      continue;
    }
    await appendEndedState(row.id, "hub restarted");

    if (!row.nodeSessionId) continue;
    // stationId deliberately has no FK — the station may be gone.
    const stationRows = await db
      .select({ nodeId: stations.nodeId })
      .from(stations)
      .where(eq(stations.id, row.stationId));
    const nodeId = stationRows[0]?.nodeId;
    if (nodeId && isNodeSessionIdLive(nodeId, row.nodeSessionId)) {
      // A live session holds this process (only possible when a node shares one
      // process across sessions). Never close it out from under that session.
      log.info(
        "ACP reconcile: node process held by a live session — not closed",
        {
          sessionId: row.id,
          nodeSessionId: row.nodeSessionId,
        },
      );
      continue;
    }
    if (nodeId && connectionManager.isOnline(nodeId)) {
      // Best-effort: broker.request never rejects; result is ignored.
      void broker.request(nodeId, "acp.close", {
        sessionId: row.nodeSessionId,
      });
      await db
        .update(acpSessions)
        .set({ nodeSessionId: null })
        .where(eq(acpSessions.id, row.id));
    } else {
      // Kept as an orphan marker (non-null node_session_id on an ended row):
      // the node-online hook below closes it when the node next connects.
      log.info("ACP reconcile: orphaned agent process awaits node reconnect", {
        sessionId: row.id,
        nodeSessionId: row.nodeSessionId,
        stationId: row.stationId,
      });
    }
  }

  if (stale.length > 0) {
    log.info(
      `ACP reconcile: ended ${stale.length} stale session(s) from before restart`,
    );
  }
}

// ─── Orphaned-process cleanup on node reconnect ──────────────────────────────

/**
 * Close agent processes orphaned by a hub restart once their node is back.
 *
 * Orphan marker: an ENDED session row that still carries node_session_id
 * (live/normal ends clear it when the close was deliverable). Fires one
 * best-effort acp.close per orphan, for that row's OWN node_session_id, and
 * clears the marker so it's once-only. Never touches non-ended rows, and skips
 * any process a live session is still holding, so live sessions are safe.
 *
 * Exported for tests; production calls it from the node-online hook below.
 */
export async function closeOrphanedProcesses(nodeId: string): Promise<void> {
  const orphans = await db
    .select({
      id: acpSessions.id,
      nodeSessionId: acpSessions.nodeSessionId,
    })
    .from(acpSessions)
    .innerJoin(stations, eq(stations.id, acpSessions.stationId))
    .where(
      and(
        eq(stations.nodeId, nodeId),
        eq(acpSessions.status, "ended"),
        isNotNull(acpSessions.nodeSessionId),
      ),
    );
  for (const orphan of orphans) {
    if (isNodeSessionIdLive(nodeId, orphan.nodeSessionId!)) {
      // A live session is talking to this very process (possible when a node
      // shares one process per station key): leave it — and its marker — alone.
      log.info("ACP orphan cleanup: process held by a live session — skipped", {
        sessionId: orphan.id,
        nodeId,
        nodeSessionId: orphan.nodeSessionId,
      });
      continue;
    }
    // Best-effort: broker.request never rejects; result is ignored.
    void broker.request(nodeId, "acp.close", {
      sessionId: orphan.nodeSessionId!,
    });
    await db
      .update(acpSessions)
      .set({ nodeSessionId: null })
      .where(eq(acpSessions.id, orphan.id));
    log.info("ACP orphan cleanup: closed agent process on reconnected node", {
      sessionId: orphan.id,
      nodeId,
      nodeSessionId: orphan.nodeSessionId,
    });
  }
}
