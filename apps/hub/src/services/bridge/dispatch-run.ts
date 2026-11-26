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
import { CAPACITY_HOLD_REASON } from "./checkpoint-capacity-backoff";
import { BridgeCredentialRefused } from "./plane-credential";
import { CheckpointRefused } from "./checkpoint-profile";
import { errorFacts, noteCheckpoint } from "./checkpoint-log";

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
        { code: checkpointRefusalCode(error), ...(reason === undefined ? {} : { reason }),
          ...(error instanceof CheckpointRefused ? {} : errorFacts(error)) });
    }
    dedicated = undefined;
  }
  if (dedicated) {
    const refuse = (refused: CheckpointRefused) => {
      if (deps.checkpointRefused) deps.checkpointRefused(refused);
      else log("checkpoint dispatch refused; ordinary claims continue", { code: refused.code, reason: refused.reason });
    };
    // **An unresolved attempt holds this station's checkpoint claims, and nothing else (#911).**
    // One unresolved attempt per station is the ledger's invariant (the node holds one bench per
    // station and a newer prepare waits on the older record), so a new checkpoint claim waits,
    // named. Ordinary claims do not: recovering one card's attempt used to end every cycle, so a
    // stale attempt stopped the agent claiming anything at all.
    let resumed: DispatchResult | undefined;
    let held = false;
    try {
      resumed = await dedicated.recover();
    } catch (error) {
      if (error instanceof SuperpipelineApiError && (error.status === 401 || error.status === 403)) throw error;
      refuse(new CheckpointRefused("uncertain", error instanceof BridgeCredentialRefused ? `credential.${error.reason}`
        : `recover.${error instanceof CheckpointRefused ? error.code : "unavailable"}`, error));
      held = true;
    }
    if (resumed && resumed.status !== "unreported") return resumed;
    // Asked after the recovery, which is how the attempt holding the station is driven at all. The
    // attempt's own pass (a remote turn still running) is the cycle's answer, so it is re-read soon.
    if (deps.benchBusy && await deps.benchBusy()) return resumed ?? { status: "idle" };
    if (resumed) {
      // A run still going (`recheckMs`, the benign execute park) holds new checkpoint claims too, but
      // it is not a refusal: the orchestrator already said it at info, and the next cycle re-reads it.
      // Naming it here put a warning in the log every few seconds of every long run.
      if (resumed.recheckMs === undefined)
        refuse(new CheckpointRefused("uncertain", resumed.reason === CAPACITY_HOLD_REASON ? "capacity.backoff" : "attempt.unresolved"));
      held = true;
    }
    if (!held) try {
      const work = await client.claim({ maxConcurrency: agent.maxConcurrency, profileKey: agent.profileKey,
        checkpointProtocol: dedicated.protocol, ...(dedicated.protocols ? { checkpointProtocols: dedicated.protocols } : {}),
        checkpointOnly: true });
      if (!work) return { status: "idle" };
      if (!work.checkpointClaim) {
        noteCheckpoint("claim", "claim.no_checkpoint_claim", { runId: work.runId });
        return { status: "unreported", reason: "Checkpoint dispatch requires reconciliation" };
      }
      return dedicated.dispatch(client, work.checkpointClaim);
    } catch (error) {
      // Preserve the loop's existing definitive credential-refusal halt.
      if (error instanceof SuperpipelineApiError && (error.status === 401 || error.status === 403)) throw error;
      // A refused plane grant is refused before any board request is sent, so nothing was claimed
      // and nothing needs reconciling. It is a checkpoint refusal like any other (#911): named,
      // rate-limited, and the cycle goes on to the ordinary claim. This used to become a silent
      // `unreported`, which the loop re-ran at once: a tight loop with no line and no claim.
      if (!(error instanceof BridgeCredentialRefused)) {
        // The claim may have landed: park, but say what failed.
        noteCheckpoint("claim", "claim.error", {}, error);
        return { status: "unreported", reason: "Checkpoint dispatch requires reconciliation" };
      }
      refuse(new CheckpointRefused("authority", `credential.${error.reason}`));
    }
  }

  // No loop on a station a remote bench stage holds claims ordinary work either (operator decision 2).
  if (deps.benchBusy && await deps.benchBusy()) return { status: "idle" };

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
