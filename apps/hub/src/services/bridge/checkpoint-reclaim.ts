/**
 * Ask a card's node to reclaim the card's bench (`bench.reclaim`). Called by the clearing sweep
 * (bench-clearing.ts) once the card is done, cancelled or dormant, never because a checkpoint
 * settled: one card keeps one bench from stage to stage and across review bounces.
 *
 * The node refuses a bench whose journal is unsettled or whose lease is held, and one that is not
 * ready. Best effort: a failed reclaim only logs, and the next sweep asks again.
 */
import { and, eq } from "drizzle-orm";
import { BenchReclaimReply, type BenchReclaimRequest } from "@agentpod/contract";

import { db } from "../../db/drizzle";
import { benchStages } from "../../db/schema/bench-stages";
import { createLogger } from "../../utils/logger";
import { request as nodeRequest } from "../broker";
import { connectionManager } from "../broker";
import { checkpointProfileId, type CheckpointProfile } from "./checkpoint-profile";

const log = createLogger("bench-clearing");

export const BENCH_RECLAIM_VERB = "bench.reclaim";
const RECLAIM_TIMEOUT_MS = 30_000;

/** Whether a profile's stage keeps its benches (`--keep-bench`): the hub never clears them. A profile only in the file does not. */
export async function stageKeepsBench(profile: CheckpointProfile): Promise<boolean> {
  const [row] = await db.select({ keepBench: benchStages.keepBench }).from(benchStages)
    .where(and(eq(benchStages.tenantId, profile.target.tenant_id), eq(benchStages.name, checkpointProfileId(profile))));
  return row?.keepBench ?? false;
}

export interface ReclaimDeps {
  request: typeof nodeRequest;
  online(nodeId: string): boolean;
}
export const reclaimDeps: ReclaimDeps = { request: nodeRequest, online: (nodeId) => connectionManager.isOnline(nodeId) };

/** Which card's bench, on which node. The node derives the bench key from these exactly as a prepare does. */
export interface ReclaimTarget { nodeId: string; tenantId: string; boardId: string; stationId: string; cardId: string }

export type ReclaimOutcome = "reclaimed" | "absent" | "refused" | "failed";

/** Reclaim the card's bench on one node. Never throws; returns what happened, for the log and the sweep. */
export async function reclaimCardBench(target: ReclaimTarget, reason: string, deps: ReclaimDeps = reclaimDeps): Promise<ReclaimOutcome> {
  const facts = { tenantId: target.tenantId, boardId: target.boardId, cardId: target.cardId, nodeId: target.nodeId, reason };
  try {
    if (!deps.online(target.nodeId)) {
      log.warn("a card's bench was not cleared: the node is offline", facts);
      return "failed";
    }
    const params: BenchReclaimRequest = { tenant_id: target.tenantId, board_id: target.boardId,
      station_id: target.stationId, card_id: target.cardId };
    const res = await deps.request(target.nodeId, BENCH_RECLAIM_VERB, params, { timeoutMs: RECLAIM_TIMEOUT_MS });
    const reply = res.ok ? BenchReclaimReply.safeParse(res.data) : undefined;
    if (!reply?.success) {
      log.warn("a card's bench was not cleared", { ...facts, error: res.ok ? "the node's answer was not a reclaim reply" : res.error });
      return "failed";
    }
    const { state, code, bench_id } = reply.data;
    if (state === "refused") {
      // A held lease or an unsettled journal is the node keeping the bench on purpose: not a fault.
      const benign = code === "lease_held" || code === "unsettled" || code === "not_ready";
      log[benign ? "info" : "warn"]("the node kept a card's bench", { ...facts, code, ...(bench_id ? { benchId: bench_id } : {}) });
      return "refused";
    }
    log.info(state === "reclaimed" ? "a card's bench was cleared" : "a card had no bench left to clear",
      { ...facts, ...(bench_id ? { benchId: bench_id } : {}) });
    return state;
  } catch (error) {
    log.warn("a card's bench was not cleared", { ...facts, error: error instanceof Error ? error.message : String(error) });
    return "failed";
  }
}
