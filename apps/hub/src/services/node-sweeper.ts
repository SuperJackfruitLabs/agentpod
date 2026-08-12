/**
 * Heartbeat sweeper — expires nodes whose TCP close never fired.
 *
 * Agents heartbeat every 15s. A node still marked online whose lastSeenAt is
 * older than OFFLINE_THRESHOLD_MS (3 missed heartbeats) gets the same full
 * teardown as a real close. False positives self-correct: a live socket's
 * next heartbeat re-registers it (gateway.ts heartbeat branch).
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import { connectionManager } from "./connection-manager";
import { dropNode } from "./broker";
import { clearNode } from "./health-cache";
import { setNodeStatus } from "./node-registry";
import { sweepStalledRuntimeStarts } from "./runtimes";

export const SWEEP_INTERVAL_MS = 15_000;
export const OFFLINE_THRESHOLD_MS = 45_000;

/** One sweep pass. Returns the nodeIds expired. Injectable `now` for tests. */
export async function sweepStaleNodes(now: number = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - OFFLINE_THRESHOLD_MS);
  const stale = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.status, "online"),
        or(isNull(nodes.lastSeenAt), lt(nodes.lastSeenAt, cutoff))
      )
    );

  for (const { id } of stale) {
    clearNode(id);
    dropNode(id);
    connectionManager.unregister(id);
    await setNodeStatus(id, "offline");
    console.log(`[sweeper] expired silent node ${id}`);
  }
  return stale.map((s) => s.id);
}

/**
 * Start the periodic sweeper. Returns a stop function.
 *
 * Two expiries share the tick because they are the same idea at two levels: a
 * node that stopped talking, and a runtime that was asked to run and never
 * produced a node at all (see sweepStalledRuntimeStarts).
 */
export function startNodeSweeper(): () => void {
  const timer = setInterval(() => {
    void sweepStaleNodes().catch((err) =>
      console.error("[sweeper] sweep failed:", err)
    );
    void sweepStalledRuntimeStarts().catch((err) =>
      console.error("[sweeper] runtime sweep failed:", err)
    );
  }, SWEEP_INTERVAL_MS);
  return () => clearInterval(timer);
}
