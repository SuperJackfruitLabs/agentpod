/** Ending a live session: the one terminal transition every end path goes through. */

import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { connectionManager } from "../broker";
import { revokeSalaamExecution } from "../salaam";
import { persistEvent, setStatus } from "./events";
import { removeLive, type LiveSession } from "./session-state";
import { turnErrorFromReason } from "./turn-error";

/** Resolve all parked permission promises with the SDK's cancelled outcome. */
export function rejectPendingPermissions(live: LiveSession): void {
  for (const [requestSeq, resolve] of live.pending) {
    resolve({ outcome: { outcome: "cancelled" } });
    persistEvent(live, "permission-answer", { requestSeq, cancelled: true });
  }
  live.pending.clear();
}

const finalizations = new WeakMap<LiveSession, Promise<void>>();
/** Every concurrent stop caller waits for the same authority/teardown barrier. */
export function finalizeEnd(
  live: LiveSession,
  reason: string,
  cause?: "idle" | "admin",
): Promise<void> {
  const pending = finalizations.get(live);
  if (pending) return pending;
  if (live.ended) return Promise.resolve();
  live.ended = true;
  const completion = Promise.resolve().then(() => finalizeEndOnce(live, reason, cause));
  finalizations.set(live, completion);
  return completion;
}
/** Terminal transition: row ended(reason) + state event, wire torn down. */
async function finalizeEndOnce(
  live: LiveSession,
  reason: string,
  cause?: "idle" | "admin",
): Promise<void> {
  clearInterval(live.authorityTimer);
  if (live.executionAuthority)
    live.executionAuthority = await revokeSalaamExecution(live.id, reason);
  if (live.graceTimer) {
    clearTimeout(live.graceTimer);
    live.graceTimer = null;
  }
  // A session ending under a running turn is why that turn failed: the node
  // went away, or the harness exited. Recorded before the ended state, so
  // every reader meets the reason before the end.
  if (live.turnInFlight && !live.turnErrorRecorded) {
    let error =
      live.pendingTurnError ??
      turnErrorFromReason(reason, live.harness, "session-state");
    if (live.executionAuthority)
      error = {
        ...error,
        failureCode: error.failureCode ?? "execution_interrupted",
        ...(live.logicalPromptInFlight
          ? { logicalRequestId: live.logicalPromptInFlight }
          : {}),
        ...(live.executionAuthority.sessionId
          ? { localSessionId: live.executionAuthority.sessionId }
          : {}),
      };
    live.turnErrorRecorded = true;
    live.turnErrorSource = error.source;
    persistEvent(live, "error", error);
  }
  const hadParked = live.pending.size > 0;
  rejectPendingPermissions(live);
  if (hadParked) {
    // The cancelled outcomes travel to the agent through SDK microtasks and a
    // synchronous broker send; yield one macrotask so they flush before the
    // wire is torn down (otherwise the agent may never see them).
    await new Promise((r) => setTimeout(r, 0));
  }
  const { done } = setStatus(live, "ended", {
    extra: {
      reason,
      ...(live.executionAuthority
        ? {
            execution: {
              state: live.executionAuthority.state,
              stopConfirmed: live.executionAuthority.state === "revoked",
            },
          }
        : {}),
      ...(cause ? { cause } : {}),
    },
    endedReason: reason,
    ...(cause ? { endedCause: cause } : {}),
    force: true,
  });
  removeLive(live);
  try {
    live.connection?.close();
  } catch {
    // Connection already closed — fine.
  }
  try {
    await live.wire?.close();
  } catch {
    // Wire already closed — fine.
  }
  await done;
  if (connectionManager.isOnline(live.nodeId)) {
    // The wire's best-effort acp.close was deliverable — clear the orphan
    // marker so the node-online hook won't re-close this process later.
    await db
      .update(acpSessions)
      .set({ nodeSessionId: null })
      .where(eq(acpSessions.id, live.id));
  }
}
