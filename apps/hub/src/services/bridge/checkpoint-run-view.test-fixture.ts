/**
 * SuperPipeline's run view (GET runs/:runId, board/run-history.ts getRunContext) for a checkpoint
 * claim, live and after a person moved the card off the stage (board/moves.ts moveCard: the run
 * stays `working`, the card's currentRunId is cleared and its stage changes).
 */
import type { PendingCheckpointClaim } from "./checkpoint-claim";

export function runView(c: PendingCheckpointClaim) {
  return {
    run: { runId: c.runId, cardId: c.cardId, stageKey: c.stageKey, leaseEpoch: c.leaseEpoch, status: "working",
      outcome: null as string | null, startedAt: "2026-11-21T10:00:00.000Z", endedAt: null as string | null, handoff: null, completion: null },
    card: { id: c.cardId, currentStageKey: c.stageKey, currentRunId: c.runId as string | null,
      delegateAgentId: c.agentId as string | null, state: "working" },
    stage: { key: c.stageKey, checkpointPolicy: c.policy as unknown },
    handoff: null, references: [], elicitations: [],
  };
}

export function movedRunView(c: PendingCheckpointClaim) {
  const live = runView(c);
  return { ...live, card: { ...live.card, currentStageKey: "review", currentRunId: null, delegateAgentId: null, state: "submitted" },
    stage: { key: "review", checkpointPolicy: null } };
}

export function endedRunView(c: PendingCheckpointClaim, outcome: string) {
  const live = runView(c);
  return { ...live, run: { ...live.run, status: "ended", outcome, endedAt: "2026-11-21T10:20:00.000Z" },
    card: { ...live.card, currentRunId: null, state: "submitted" } };
}
