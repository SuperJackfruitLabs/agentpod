import { resumeSalaamWork, startSalaamWork } from "./salaam-dispatch";
/** One claim cycle: the strict-work check, the readiness probe, the claim. Split out of dispatch.ts, unchanged. */

import { inDispatchSpan } from "../../telemetry/dispatch-span";
import type { DispatchDeps, DispatchResult } from "./dispatch-types";
import { probeReadiness } from "./dispatch-readiness";
import { workClaimed } from "./dispatch-work";
import { recoverPermissionWaits } from "./dispatch-recover";
import { selectCheckpointDispatch } from "./checkpoint-dispatch";
import { checkpointRefusalCode, checkpointRefusalReason } from "./checkpoint-isolation";
import { SuperpipelineApiError } from "./superpipeline";

export async function runOnce(deps: DispatchDeps): Promise<DispatchResult> {
  const { client, acp, agent } = deps;
  const log = deps.log ?? (() => {});

  // A permission wait a restart cut short is ended before anything is claimed (charter: "Unanswered
  // decisions remind, then escalate" §8). A failure here must not stop the agent claiming: the
  // next cycle tries again.
  await recoverPermissionWaits(deps).catch((err: unknown) =>
    log("could not recover permission waits a restart cut short", { error: String(err) }),
  );

  // Dedicated work is selected before ACP probing, Salaam recovery or prior-output replay.
  // A refused selection is the checkpoint stage's alone: nothing is claimed for it this cycle,
  // and the cycle continues with ordinary claims, which never select a checkpoint stage.
  let dedicated;
  try {
    dedicated = await selectCheckpointDispatch(deps.checkpoint, {
      tenantId: deps.tenantId, boardId: agent.boardId, stationId: agent.stationId,
    });
  } catch (error) {
    if (deps.checkpointRefused) deps.checkpointRefused(error);
    else {
      const reason = checkpointRefusalReason(error);
      log("checkpoint dispatch refused; ordinary claims continue",
        { code: checkpointRefusalCode(error), ...(reason === undefined ? {} : { reason }) });
    }
    dedicated = undefined;
  }
  if (dedicated) {
    try {
      const resumed = await dedicated.recover();
      if (resumed) return resumed;
      const work = await client.claim({ maxConcurrency: agent.maxConcurrency, profileKey: agent.profileKey,
        checkpointProtocol: dedicated.protocol, checkpointOnly: true });
      if (!work) return { status: "idle" };
      if (!work.checkpointClaim) return { status: "unreported", reason: "Checkpoint dispatch requires reconciliation" };
      return dedicated.dispatch(client, work.checkpointClaim);
    } catch (error) {
      // Preserve the loop's existing definitive credential-refusal halt.
      if (error instanceof SuperpipelineApiError && (error.status === 401 || error.status === 403)) throw error;
      return { status: "unreported", reason: "Checkpoint dispatch requires reconciliation" };
    }
  }

  const strict = await acp.strictWork?.({
    stationId: agent.stationId,
    tenantId: deps.tenantId,
    userId: agent.hubUserId,
  });
  if (strict?.required) {
    if (strict.version !== 1)
      return {
        status: "not-ready",
        reason: strict.reason ?? "Strict work protocol unavailable",
      };
    const resumed = await resumeSalaamWork(deps);
    if (resumed) return resumed;
  }

  // ─── requirement 4a: do not claim work there is nowhere to run ─────────────
  // The board hands out a card on a claim; the hub cannot un-hand it for 15
  // minutes except by asking. Checking first is what removes the race entirely,
  // including the restart case that produced it — the bridge starts with the
  // hub, the node-agents dial back in seconds later.
  const readiness = await probeReadiness(acp, agent, deps.tenantId);
  if (!readiness.ready) {
    const reason = readiness.reason ?? "the station cannot run work right now";
    log("not claiming: the station is not ready", { station: agent.stationId, reason });
    return { status: "not-ready", reason };
  }

  const claimedAt = new Date();
  const work = await client.claim({ maxConcurrency: agent.maxConcurrency, profileKey: agent.profileKey });
  // A bare "not claimed" covers an empty queue, an over-budget board and an
  // agent at its concurrency cap alike. superpipeline does not say which.
  if (!work) return { status: "idle" };
  if (strict?.required)
    return inDispatchSpan(
      {
        runId: work.runId,
        boardId: agent.boardId,
        cardId: work.card.id,
        source: deps.source,
        stationId: agent.stationId,
        startTime: claimedAt,
        observation: "strict-start",
        runEpoch: work.leaseEpoch,
      },
      (spans) => startSalaamWork(deps, work, spans),
    );

  return inDispatchSpan(
    { runId: work.runId, boardId: agent.boardId, cardId: work.card.id, source: deps.source, stationId: agent.stationId, startTime: claimedAt },
    (spans) => workClaimed(deps, work, spans),
  );
}
