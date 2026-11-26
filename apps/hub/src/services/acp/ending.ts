/** Ending a session on request: its owner's end, and a workspace admin's. */

import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { stations } from "../../db/schema/stations";
import * as broker from "../broker";
import { connectionManager } from "../broker";
import { revokeSalaamExecution } from "../salaam";
import { finalizeEnd } from "./end";
import { appendEndedState } from "./events";
import { log } from "./log";
import { isNodeSessionIdLive, liveById } from "./session-state";
import { sessionLockKey, withStationOpenLock } from "./timing";

export async function endSession(
  userId: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  const live = liveById.get(sessionId);
  if (live) {
    if (live.userId !== userId) throw new Error("Session not found.");
    await finalizeEnd(live, reason);
    return;
  }
  // Not live (e.g. found via a stale row): mark the row ended if owned — under the same
  // per-session lock as recovery, so a restore cannot interleave with this end (#773).
  const restored = await withStationOpenLock(sessionLockKey(sessionId), async () => {
    const now = liveById.get(sessionId);
    if (now) return now;
    const rows = await db
      .select()
      .from(acpSessions)
      .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)));
    if (!rows[0]) throw new Error("Session not found.");
    if (rows[0].executionAuthority)
      await revokeSalaamExecution(sessionId, reason);
    if (rows[0].status !== "ended") await appendEndedState(sessionId, reason);
    return null;
  });
  if (restored) {
    if (restored.userId !== userId) throw new Error("Session not found.");
    await finalizeEnd(restored, reason);
  }
}

/**
 * A workspace owner/admin ends someone else's session (spec: session lifecycle, 2026-10-23):
 * the same end and confirmed revocation as the owner's own, with `endedCause: "admin"` on the row.
 * The caller decides the role and writes the audit entry; this checks only that the session is in
 * the caller's workspace. Returns the ended row's owner and station, or null when not found.
 */
export async function endSessionAsWorkspaceAdmin(
  tenantId: string,
  sessionId: string,
  reason: string,
): Promise<{ userId: string; stationId: string } | null> {
  const [row] = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.tenantId, tenantId)));
  if (!row) return null;
  const live = liveById.get(sessionId);
  if (live) await finalizeEnd(live, reason, "admin");
  else {
    const restored = await withStationOpenLock(sessionLockKey(sessionId), async () => {
      const now = liveById.get(sessionId);
      if (now) return now;
      const [fresh] = await db.select().from(acpSessions).where(eq(acpSessions.id, sessionId));
      if (fresh?.executionAuthority) await revokeSalaamExecution(sessionId, reason);
      if (fresh && fresh.status !== "ended") await appendEndedState(sessionId, reason, "admin");
      return null;
    });
    if (restored) await finalizeEnd(restored, reason, "admin");
  }
  return { userId: row.userId, stationId: row.stationId };
}

/** How long a confirmed close waits on the node: a local process stop there. */
export const CONFIRMED_CLOSE_TIMEOUT_MS = 10_000;

/**
 * End every session on a station and confirm that no agent process any of them started is still
 * running, for a caller that must never let two sessions work in one place (a remote bench stage,
 * whose sessions all work in one bench, before it opens a fresh one after a hub restart).
 *
 * - Each session not yet ended is ended here (`endSession`, live or not).
 * - Each session whose row still names its node process (`node_session_id`: one not yet closed, or
 *   an orphan a hub restart left) gets an awaited `acp.close`. The node answers ok once the process
 *   is gone, or was never there; only that answer clears the marker.
 * - An ended row that names no node process left was closed already.
 *
 * True only when every one is confirmed. A station that is gone, a node that is offline or does
 * not answer, or a process another live session still holds is not a confirmation.
 */
export async function closeStationSessions(tenantId: string, stationId: string, reason: string): Promise<boolean> {
  const [station] = await db.select({ nodeId: stations.nodeId }).from(stations)
    .where(and(eq(stations.id, stationId), eq(stations.tenantId, tenantId)));
  if (!station) return false;
  const rows = await db.select({ id: acpSessions.id, userId: acpSessions.userId, status: acpSessions.status,
    nodeSessionId: acpSessions.nodeSessionId }).from(acpSessions)
    .where(and(eq(acpSessions.tenantId, tenantId), eq(acpSessions.stationId, stationId),
      or(ne(acpSessions.status, "ended"), isNotNull(acpSessions.nodeSessionId))));
  let confirmed = true;
  // Every session ends first, so a process a sibling on this station held is free to close below.
  for (const row of rows) {
    if (row.status === "ended" && !liveById.has(row.id)) continue;
    try { await endSession(row.userId, row.id, reason); }
    catch (error) {
      confirmed = false;
      log.warn("ACP station close: a session could not be ended", { sessionId: row.id, stationId,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const row of rows) {
    const proc = row.nodeSessionId;
    if (!proc) continue;
    if (isNodeSessionIdLive(station.nodeId, proc) || !connectionManager.isOnline(station.nodeId)) { confirmed = false; continue; }
    const closed = await broker.request(station.nodeId, "acp.close", { sessionId: proc }, { timeoutMs: CONFIRMED_CLOSE_TIMEOUT_MS });
    if (!closed.ok) {
      confirmed = false;
      log.warn("ACP station close: the node did not confirm a process closed", { sessionId: row.id, stationId,
        nodeSessionId: proc, error: closed.error });
      continue;
    }
    await db.update(acpSessions).set({ nodeSessionId: null })
      .where(and(eq(acpSessions.id, row.id), eq(acpSessions.nodeSessionId, proc)));
  }
  return confirmed;
}
