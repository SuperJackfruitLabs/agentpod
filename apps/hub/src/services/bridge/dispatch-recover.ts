/**
 * A board-dispatched permission wait that a restart cut short (charter: "Unanswered decisions
 * remind, then escalate" §8).
 *
 * The wait used to live only in memory: a hub restart lost it, the ledger row stayed `working`
 * forever, and the card sat on the board until its lease lapsed fifteen minutes later with nothing
 * saying why. It is recorded on the dispatch row now (`recordPermissionWait`), from the moment it
 * starts until it ends.
 *
 * **Recovery ends it; it does not resume it.** The harness's `session/request_permission` is a
 * pending JSON-RPC request held by the process that drove the session (`acp/permissions.ts`,
 * `live.pending`). After a restart there is nothing left to deliver an answer to, so waiting on to
 * the deadline would only hold the card on a question whose answer cannot reach anybody. The run is
 * ended as unanswered at once, exactly as `endUnanswered` ends a wait that ran out: the session is
 * ended, the attempt closed, the board told `fail` (so the question is asked again on the next
 * attempt, and the circuit breaker parks the card if nobody ever answers), and the row abandoned.
 *
 * Run at the top of every claim cycle, before the claim, so it is retried until the board hears.
 * It reads only this agent's rows, and a loop is serial, so a wait this process is holding is never
 * among them.
 */

import { endAttempt, clearPermissionWait, markAbandoned, openPermissionWaits, type OpenPermissionWait } from "./ledger";
import { isForeignRun, isLeaseSuperseded } from "./superpipeline";
import type { DispatchDeps } from "./dispatch-types";

function whyEnded(wait: OpenPermissionWait, now: number): string {
  return now >= wait.until.getTime()
    ? "the agent asked for permission and nobody answered before the wait ran out (the hub restarted meanwhile)"
    : "the hub restarted while the agent waited for a permission answer, so the harness can no longer receive one";
}

/** End every wait this agent's previous process left behind. The count ended. */
export async function recoverPermissionWaits(
  deps: Pick<DispatchDeps, "client" | "acp" | "agent" | "tenantId" | "source" | "log">,
  now: () => number = Date.now,
): Promise<number> {
  const log = deps.log ?? (() => {});
  const waits = await openPermissionWaits({
    tenantId: deps.tenantId,
    externalSource: deps.source,
    boardId: deps.agent.boardId,
    agentKey: deps.agent.key,
  });
  let ended = 0;
  for (const wait of waits) {
    const reason = whyEnded(wait, now());
    try {
      await deps.client.fail({ runId: wait.key.externalRunId, leaseEpoch: wait.leaseEpoch }, reason);
    } catch (err) {
      // The board already moved on (reclaimed, or the run is another agent's now): there is nobody
      // left to tell, and the row is closed below. Anything else, it has not heard: try next cycle.
      if (!isLeaseSuperseded(err) && !isForeignRun(err)) {
        log("a permission wait cut short by a restart could not be ended on the board yet", {
          run: wait.key.externalRunId,
          error: String(err),
        });
        continue;
      }
    }
    if (wait.sessionId) await deps.acp.endSession(deps.agent.hubUserId, wait.sessionId, reason).catch(() => {});
    if (wait.acpRunId) await endAttempt(wait.acpRunId, "failed", null).catch(() => {});
    await markAbandoned(wait.key, reason);
    await clearPermissionWait(wait.key);
    log("ended a permission wait a restart cut short", { run: wait.key.externalRunId, card: wait.key.externalCardId });
    ended++;
  }
  return ended;
}
