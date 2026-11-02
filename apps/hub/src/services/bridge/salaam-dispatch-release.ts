import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { bridgeDispatches } from "../../db/schema/bridge";
import { salaamWorkOwners } from "../../db/schema/salaam-work";
import type { DispatchDeps } from "./dispatch-types";
import { stoppedUnownedSession } from "./salaam-dispatch-proofs";

/** Reconcile only a producer-confirmed original release with no execution owner.
 * Operator recovery requires the roster paused and controller quiesced.
 * Historical recovery does not dispatch, reclaim, or infer release from a timeout. */
export async function reconcileUnopenedSalaamRelease(
  deps: DispatchDeps,
  runId: string,
  stageKey: string,
): Promise<boolean> {
  const filter = and(
    eq(bridgeDispatches.tenantId, deps.tenantId),
    eq(bridgeDispatches.externalSource, deps.source),
    eq(bridgeDispatches.externalRunId, runId),
    eq(bridgeDispatches.stationId, deps.agent.stationId),
    eq(bridgeDispatches.agentKey, deps.agent.key),
    eq(bridgeDispatches.boardId, deps.agent.boardId),
  );
  const [saved] = await db.select().from(bridgeDispatches).where(filter);
  if (!saved || saved.outcome !== "working") return false;
  const original = await deps.client.context(runId);
  if (
    original.run.stageKey !== stageKey ||
    original.stage?.key !== stageKey ||
    original.run.runId !== runId ||
    original.run.cardId !== saved.externalCardId ||
    original.run.leaseEpoch !== saved.leaseEpoch ||
    original.run.status !== "ended" ||
    original.run.outcome !== "released"
  )
    return false;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(bridgeDispatches)
      .where(filter)
      .for("update");
    if (
      !current ||
      current.outcome !== "working" ||
      current.leaseEpoch !== saved.leaseEpoch
    )
      return false;
    const owners = await tx
      .select({ id: salaamWorkOwners.requestId })
      .from(salaamWorkOwners)
      .where(
        and(
          eq(salaamWorkOwners.externalSource, deps.source),
          eq(salaamWorkOwners.externalRunId, runId),
        ),
      );
    const sessions = await tx
      .select()
      .from(acpSessions)
      .where(
        and(
          eq(acpSessions.tenantId, deps.tenantId),
          sql`${acpSessions.executionAuthority}->'binding'->'run'->>'source' = ${deps.source}`,
          sql`${acpSessions.executionAuthority}->'binding'->'run'->>'id' = ${runId}`,
        ),
      );
    if (
      owners.length ||
      sessions.some(
        (row) =>
          row.stationId !== deps.agent.stationId ||
          row.userId !== deps.agent.hubUserId ||
          !stoppedUnownedSession(row, runId, current.leaseEpoch),
      )
    )
      return false;
    await tx
      .update(bridgeDispatches)
      .set({
        outcome: sessions.length ? "abandoned" : "released",
        reason: sessions.length
          ? "Original producer released; failed session has exact terminal stop receipt and no work owner"
          : "Original producer run confirms release before execution ownership",
        updatedAt: new Date(),
      })
      .where(filter);
    return true;
  });
}
