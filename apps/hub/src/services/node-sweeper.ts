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
import {
  sweepStalledRuntimeStarts,
  sweepStalledRuntimeStops,
  sweepExpiringRuntimes,
} from "./runtimes";

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
 * Four expiries share the tick because they are the same idea at four levels: a
 * node that stopped talking, a runtime that was asked to run and never produced
 * a node at all (sweepStalledRuntimeStarts), a runtime that was asked to stop
 * and has not been seen to (sweepStalledRuntimeStops), and the one nobody asked
 * for — a runtime the SUBSTRATE is about to destroy for age while it is working
 * perfectly (sweepExpiringRuntimes).
 */
export function startNodeSweeper(): () => void {
  const timer = setInterval(() => {
    void sweepStaleNodes().catch((err) =>
      console.error("[sweeper] sweep failed:", err)
    );
    void sweepStalledRuntimeStarts().catch((err) =>
      console.error("[sweeper] runtime sweep failed:", err)
    );
    // Also the confirmation path, not only an expiry: this is what turns a
    // `stopping` runtime into `stopped` once the substrate says it is down.
    void sweepStalledRuntimeStops().catch((err) =>
      console.error("[sweeper] runtime stop sweep failed:", err)
    );
    // And the one nobody asked for: a runtime the substrate is about to destroy
    // for age. A capped substrate (Modal's sandboxes die at 24 hours however
    // healthy they are, with no warning and no way back) would otherwise take a
    // station down once a day, so the hub replaces the instance before that
    // lands. Driven by the driver's declared ceiling, so uncapped substrates
    // cost nothing here.
    void sweepExpiringRuntimes().catch((err) =>
      console.error("[sweeper] runtime rotation sweep failed:", err)
    );
  }, SWEEP_INTERVAL_MS);
  return () => clearInterval(timer);
}
