/**
 * After a card's checkpoint is settled (pushed to `card/<id>` and the settlement accepted), the hub
 * asks the node to reclaim that card's bench. A settled bench otherwise stays `ready` with its whole
 * quota reserved until SuperBench's idle sweep, and a host fills after a few cards
 * (`capacity_exhausted`). A card that comes back later (a review bounce) gets a fresh bench prepared
 * from its card branch.
 *
 * Per stage, on by default; `fleet bench stage set NAME --keep-bench` turns it off. Never for a card
 * with another unsettled attempt, and the node refuses a bench whose journal is unsettled or whose
 * lease is held. Best effort: a failed reclaim only logs; the card is already reported.
 */
import { and, eq } from "drizzle-orm";
import { BenchReclaimReply, type BenchReclaimRequest } from "@agentpod/contract";

import { db } from "../../db/drizzle";
import { benchStages } from "../../db/schema/bench-stages";
import { createLogger } from "../../utils/logger";
import { request as nodeRequest } from "../broker";
import { connectionManager } from "../broker";
import { checkpointProfileId, type CheckpointProfile } from "./checkpoint-profile";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { unresolvedCheckpointAttempts } from "./checkpoint-ledger";

const log = createLogger("bridge-checkpoint");

export const BENCH_RECLAIM_VERB = "bench.reclaim";
const RECLAIM_TIMEOUT_MS = 30_000;

export interface ReclaimDeps {
  /** Whether the attempt's stage keeps its benches (`--keep-bench`). A stage only in the profile file reclaims. */
  keepBench(attempt: RetainedCheckpointAttempt): Promise<boolean>;
  /** Another attempt on the same card that has not settled. */
  unsettledSibling(attempt: RetainedCheckpointAttempt): Promise<boolean>;
  request: typeof nodeRequest;
  online(nodeId: string): boolean;
}

/** Whether a profile's stage keeps its benches. A profile with no stage row (one only in the file) reclaims. */
export async function stageKeepsBench(profile: CheckpointProfile): Promise<boolean> {
  const [row] = await db.select({ keepBench: benchStages.keepBench }).from(benchStages)
    .where(and(eq(benchStages.tenantId, profile.target.tenant_id), eq(benchStages.name, checkpointProfileId(profile))));
  return row?.keepBench ?? false;
}

export const reclaimDeps: ReclaimDeps = {
  keepBench: (attempt) => stageKeepsBench(attempt.profile),
  async unsettledSibling(attempt) {
    const rows = await unresolvedCheckpointAttempts(attempt.row.tenantId);
    return rows.some((row) => row.attemptId !== attempt.row.attemptId && row.boardId === attempt.row.boardId &&
      cardOf(row.prepareRequest) === attempt.request.identity.card_id);
  },
  request: nodeRequest,
  online: (nodeId) => connectionManager.isOnline(nodeId),
};

function cardOf(prepareRequest: string): string | undefined {
  try {
    const value: unknown = JSON.parse(prepareRequest);
    const identity = value && typeof value === "object" ? Reflect.get(value, "identity") : undefined;
    const card = identity && typeof identity === "object" ? Reflect.get(identity, "card_id") : undefined;
    return typeof card === "string" ? card : undefined;
  } catch { // silent-catch-ok: a row whose request does not parse names no card, so it is no sibling of this one
    return undefined;
  }
}

export type ReclaimOutcome = "reclaimed" | "absent" | "kept" | "unsettled" | "refused" | "failed";

/** Reclaim the settled card's bench. Never throws; returns what happened, for the log and tests. */
export async function reclaimSettledBench(attempt: RetainedCheckpointAttempt, deps: ReclaimDeps = reclaimDeps): Promise<ReclaimOutcome> {
  const facts = { tenantId: attempt.row.tenantId, boardId: attempt.row.boardId, attemptId: attempt.row.attemptId,
    nodeId: attempt.profile.target.node_id };
  try {
    if (await deps.keepBench(attempt)) {
      log.info("checkpoint settled; the stage keeps its benches (--keep-bench)", facts);
      return "kept";
    }
    if (await deps.unsettledSibling(attempt)) {
      log.info("checkpoint settled; the card has another unsettled attempt, so its bench is kept", facts);
      return "unsettled";
    }
    if (!deps.online(attempt.profile.target.node_id)) {
      log.warn("checkpoint settled; its bench was not reclaimed: the node is offline", facts);
      return "failed";
    }
    const identity = attempt.request.identity;
    const params: BenchReclaimRequest = { tenant_id: identity.tenant_id, board_id: identity.board_id,
      station_id: identity.station_id, card_id: identity.card_id };
    const res = await deps.request(attempt.profile.target.node_id, BENCH_RECLAIM_VERB, params, { timeoutMs: RECLAIM_TIMEOUT_MS });
    const reply = res.ok ? BenchReclaimReply.safeParse(res.data) : undefined;
    if (!reply?.success) {
      log.warn("checkpoint settled; its bench was not reclaimed", { ...facts, error: res.ok ? "the node's answer was not a reclaim reply" : res.error });
      return "failed";
    }
    const { state, code, bench_id } = reply.data;
    if (state === "refused") {
      // A held lease or an unsettled journal is the node keeping the bench on purpose: not a fault.
      const benign = code === "lease_held" || code === "unsettled" || code === "not_ready";
      log[benign ? "info" : "warn"]("checkpoint settled; the node kept its bench", { ...facts, code, ...(bench_id ? { benchId: bench_id } : {}) });
      return "refused";
    }
    log.info(state === "reclaimed" ? "checkpoint settled; its bench was reclaimed" : "checkpoint settled; it had no bench left to reclaim",
      { ...facts, ...(bench_id ? { benchId: bench_id } : {}) });
    return state;
  } catch (error) {
    log.warn("checkpoint settled; its bench was not reclaimed", { ...facts, error: error instanceof Error ? error.message : String(error) });
    return "failed";
  }
}
