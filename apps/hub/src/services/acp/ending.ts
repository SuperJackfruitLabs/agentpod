/** Ending a session on request: its owner's end, and a workspace admin's. */

import { and, eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { revokeSalaamExecution } from "../salaam";
import { finalizeEnd } from "./end";
import { appendEndedState } from "./events";
import { liveById } from "./session-state";
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
