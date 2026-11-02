/** Cancelling the turn in flight: `session/cancel`, or a Salaam cancellation intent. */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpPromptRequests } from "../../db/schema/acp";
import { readSalaamCancellation, type SalaamCancellationState } from "../salaam";
import { rejectPendingPermissions } from "./end";
import { setStatus } from "./events";
import { resendSalaamCancellation } from "./salaam-authority";
import { liveById, requireLive } from "./session-state";
import { withStationOpenLock } from "./timing";

export async function cancelTurn(
  userId: string,
  sessionId: string,
): Promise<void> {
  const bound = liveById.get(sessionId);
  if (bound?.executionAuthority)
    return withStationOpenLock("prompt:" + sessionId, () => cancelSalaamTurn(userId, sessionId));
  const live = requireLive(userId, sessionId);
  if (live.status !== "working" && live.status !== "waiting") return;
  const agent = live.agent;
  rejectPendingPermissions(live);
  if (agent) {
    await agent
      .notify("session/cancel", { sessionId: live.acpSessionId })
      .catch(() => {
        // Errored writable after wire close — teardown handles the session.
      });
  }
  await setStatus(live, "idle").done;
}

let salaamCancelBeforeNotifyForTest: (() => Promise<void>) | undefined;
export function _setSalaamCancelBeforeNotifyForTest(
  hook?: () => Promise<void>,
): void {
  salaamCancelBeforeNotifyForTest = hook;
}

/**
 * A Salaam session's cancel, under its prompt lock: a durable cancellation intent for the one
 * pending instruction, saved and then sent (and re-sent on recovery until confirmed).
 */
async function cancelSalaamTurn(userId: string, sessionId: string): Promise<void> {
  const live = requireLive(userId, sessionId);
  const saved = await readSalaamCancellation(live.id);
  let target =
    saved && saved.state !== "confirmed"
      ? saved.targetRequestId
      : live.logicalPromptInFlight;
  if (!target) {
    const pending = await db
      .select({ requestId: acpPromptRequests.requestId })
      .from(acpPromptRequests)
      .where(
        and(
          eq(acpPromptRequests.sessionId, live.id),
          inArray(acpPromptRequests.state, [
            "prepared",
            "dispatched",
            "accepted",
            "unknown",
          ]),
        ),
      )
      .limit(2);
    if (pending.length > 1)
      throw Error(
        "Multiple pending instructions require explicit session revocation",
      );
    target = pending[0]?.requestId;
  }
  if (!target) return;
  if (
    saved &&
    saved.state !== "confirmed" &&
    live.logicalPromptInFlight &&
    live.logicalPromptInFlight !== target
  )
    throw Error(
      "Reconcile the previous cancellation before cancelling another instruction",
    );
  const intent: SalaamCancellationState =
    saved && saved.state !== "confirmed"
      ? saved
      : {
          requestId: crypto.randomUUID(),
          targetRequestId: target,
          state: "requested",
          source: "hub-intent",
        };
  live.pendingCancellation = intent;
  rejectPendingPermissions(live);
  if (intent !== saved)
    await setStatus(live, live.turnInFlight ? "working" : "waiting", {
      extra: { cancellation: intent },
      force: true,
    }).done;
  await salaamCancelBeforeNotifyForTest?.();
  await resendSalaamCancellation(live);
}
