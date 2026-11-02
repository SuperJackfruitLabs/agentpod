/** A stopped strict run: settled when Salaam proves its effects, parked when it cannot. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/drizzle";
import { bridgeDispatches } from "../../db/schema/bridge";
import { salaamWorkDecisions, salaamWorkOwners } from "../../db/schema/salaam-work";
import { SalaamWorkPayload } from "../../../../../packages/contract/src/salaam-work-payload";
import * as broker from "../broker";
import type { DispatchDeps } from "./dispatch-types";
import { workLog } from "./salaam-dispatch-log";
import { stoppedSettlementId } from "./salaam-dispatch-proofs";
import { settleNeverDispatchedSalaamWork } from "./salaam-dispatch-settle";

/**
 * Settle a stopped strict run with its known effects preserved, but only after Salaam's own status
 * says the run is one it can prove (`settlement_ready`). Asking first matters: the settlement ends
 * the board run before Salaam records it, so without the proof up front a refusal would leave the
 * card free to re-run over effects nobody had proved. Throws, having changed nothing, otherwise.
 */
export async function settleStoppedSalaamWork(deps: DispatchDeps, runId: string): Promise<void> {
  const [owner] = await db
    .select()
    .from(salaamWorkOwners)
    .where(
      and(
        eq(salaamWorkOwners.tenantId, deps.tenantId),
        eq(salaamWorkOwners.externalSource, deps.source),
        eq(salaamWorkOwners.externalRunId, runId),
      ),
    );
  if (!owner) throw Error("No strict work owner");
  if (owner.settlement) throw Error("A settlement is already in progress for this run");
  // An expired, unanswered approval is its own terminal protocol (salaam.work-expire). Its first
  // settlement can race the session's stop receipt and park the run; settle it here on re-offer.
  const expired = (
    await db.select().from(salaamWorkDecisions).where(eq(salaamWorkDecisions.workRequestId, owner.requestId))
  ).filter(
    (d) => !d.answer && !d.daemonReceipt && Number((d.decision as { expires_at: unknown }).expires_at) <= Date.now(),
  );
  if (expired.length === 1) {
    await settleNeverDispatchedSalaamWork(deps, runId, expired[0]!.requestId, expired[0]!.requestId);
    return;
  }
  const binding = SalaamWorkPayload.parse(owner.payload).admission.binding;
  const status = await broker.request(binding.node_id, "salaam.work-status", { binding }, { timeoutMs: 125_000 });
  const ready = z
    .object({ work_request_id: z.literal(owner.requestId), settlement_ready: z.literal("known_effects_failure") })
    .passthrough()
    .safeParse(status.ok ? status.data : null);
  if (!ready.success) {
    // Salaam names the refusing guard (a code and fixed message) for a stopped run; say it.
    // Never dropped for length (that read the same as absent): kept, cut with a marker.
    const refused = z
      .object({ settlement_refused: z.string().transform((s) => (s.length > 1000 ? s.slice(0, 1000) + "… [cut]" : s)) })
      .safeParse(status.ok ? status.data : null);
    throw Error(
      "Salaam cannot prove this stopped run's effects" +
        (refused.success
          ? ` (${refused.data.settlement_refused})`
          : !status.ok
            // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- the daemon's error is not proven a string
            ? ` (status unreadable: ${String(status.error ?? "no answer").slice(0, 300)})`
            : ` (status does not match: ${ready.error.issues.map((i) => i.path.join(".") || "status").join(", ")})`),
    );
  }
  await settleNeverDispatchedSalaamWork(deps, runId, stoppedSettlementId(runId), undefined, true);
}

/**
 * A stopped strict run (a runtime or budget limit, a failed step) that Salaam can prove is retired
 * as not completed with its effects kept, as an expired approval already is, so the card can run
 * again without anyone clearing it. True when settled; false leaves everything as it was.
 */
async function settleStoppedRun(deps: DispatchDeps, runId: string, leaseEpoch: number): Promise<boolean> {
  try {
    await (deps.settleStoppedWork ?? ((id: string) => settleStoppedSalaamWork(deps, id)))(runId);
  } catch (error) {
    workLog.info("salaam work: stopped run not settled automatically", { run: runId, error: String(error) });
    return false;
  }
  workLog.info("salaam work: stopped run settled", { run: runId });
  try {
    await deps.client.activity(
      { runId, leaseEpoch },
      {
        type: "thought",
        body:
          "This run stopped before it could finish. Salaam checked what it had changed and kept it, " +
          "and the run was retired as not completed, so the card can be run again.",
      },
    );
  } catch {
    /* the card note is best effort; the settlement is the record */
  }
  return true;
}

/** When each parked run (by park time) was last offered the settlement; settled ones are kept
 * as Infinity so they are never offered again. A refusal is offered again after the retry
 * interval, so a run parked before Salaam could prove it settles once it can, unattended. */
const offeredSettlement = new Map<string, number>();
const SETTLEMENT_RETRY_MS = 10 * 60_000;

/**
 * #786: park a strict run that cannot be driven any more, so the roster can claim new work. Only the
 * transition from "working" surfaces it (card and log), so it is said once. Parking settles and
 * completes nothing: an operator settlement still reads the stopped owner and retires the row.
 */
export async function parkStrictRun(
  deps: DispatchDeps,
  runId: string,
  leaseEpoch: number,
  reason: string,
  note: string,
): Promise<"settled" | "parked"> {
  if (await settleStoppedRun(deps, runId, leaseEpoch)) return "settled";
  const parked = await db
    .update(bridgeDispatches)
    .set({ outcome: "parked", reason, updatedAt: new Date() })
    .where(
      and(
        eq(bridgeDispatches.tenantId, deps.tenantId),
        eq(bridgeDispatches.externalRunId, runId),
        eq(bridgeDispatches.externalSource, deps.source),
        eq(bridgeDispatches.outcome, "working"),
      ),
    )
    .returning({ id: bridgeDispatches.externalRunId, updatedAt: bridgeDispatches.updatedAt });
  if (!parked.length) return "parked";
  // Just offered: the sweep below need not offer this parking again.
  offeredSettlement.set(runId + "@" + parked[0]!.updatedAt.getTime(), Date.now());
  workLog.info("salaam work: parked", { run: runId, reason });
  try {
    await deps.client.activity({ runId, leaseEpoch }, { type: "thought", body: note });
  } catch {
    /* the card note is best effort; the log and the parked row are the record */
  }
  return "parked";
}

/** A run parked before automatic settlement existed, or since a hub restart, gets one offer. */
export async function offerParkedSettlements(deps: DispatchDeps): Promise<void> {
  const parked = await db
    .select({
      runId: bridgeDispatches.externalRunId,
      leaseEpoch: bridgeDispatches.leaseEpoch,
      updatedAt: bridgeDispatches.updatedAt,
    })
    .from(bridgeDispatches)
    .where(
      and(
        eq(bridgeDispatches.tenantId, deps.tenantId),
        eq(bridgeDispatches.externalSource, deps.source),
        eq(bridgeDispatches.agentKey, deps.agent.key),
        eq(bridgeDispatches.boardId, deps.agent.boardId),
        eq(bridgeDispatches.outcome, "parked"),
      ),
    );
  for (const row of parked) {
    const key = row.runId + "@" + row.updatedAt.getTime();
    const last = offeredSettlement.get(key);
    if (last !== undefined && Date.now() - last < (deps.settlementRetryMs ?? SETTLEMENT_RETRY_MS)) continue;
    offeredSettlement.set(key, Date.now());
    if (await settleStoppedRun(deps, row.runId, row.leaseEpoch)) offeredSettlement.set(key, Infinity);
  }
}
