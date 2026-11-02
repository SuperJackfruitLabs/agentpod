import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { stations } from "../../db/schema/stations";
import { tenantScope } from "../../db/tenant-scope";
import type { AgentSpanRecorder } from "../../telemetry/agent-spans";
import type { DispatchDeps, DispatchResult } from "./dispatch-types";
import { markReleased, openDispatch } from "./ledger";
import { driveSalaamWork } from "./salaam-dispatch-drive";
import { exclusively } from "./salaam-dispatch-drivers";
import { planFrom } from "./salaam-dispatch-plan";
import { reserveSalaamWork } from "./salaam-work";
import type { ClaimedWork } from "./superpipeline";

export async function startSalaamWork(
  deps: DispatchDeps,
  claim: ClaimedWork,
  spans?: AgentSpanRecorder,
): Promise<DispatchResult> {
  return exclusively(claim.runId, () => startClaimedSalaamWork(deps, claim, spans));
}

async function startClaimedSalaamWork(
  deps: DispatchDeps,
  claim: ClaimedWork,
  spans?: AgentSpanRecorder,
): Promise<DispatchResult> {
  const { agent, client, acp } = deps;
  let session: string | undefined;
  try {
    const context = await client.context(claim.runId);
    planFrom(context); // Reject missing explicit acceptance before opening execution.
    await openDispatch({
      tenantId: deps.tenantId,
      externalSource: deps.source,
      externalRunId: claim.runId,
      externalCardId: claim.card.id,
      boardId: agent.boardId,
      agentKey: agent.key,
      stationId: agent.stationId,
      leaseEpoch: claim.leaseEpoch,
    });
    await client.heartbeat(claim);
    const [station] = await db
      .select({ mcpProxy: stations.mcpProxy })
      .from(stations)
      .where(
        tenantScope(stations, deps.tenantId, eq(stations.id, agent.stationId)),
      );
    if (!station) throw Error("Strict work station ownership unavailable");
    session = (
      await acp.createSession({
        stationId: agent.stationId,
        tenantId: deps.tenantId,
        userId: agent.hubUserId,
        mode: "ask",
        // Only the operator's explicit station declaration requests managed tools.
        // Native-only tasks must not implicitly acquire proxy capabilities.
        mcpProxy: station.mcpProxy === true,
        executionRun: {
          source: "superpipeline",
          id: claim.runId,
          epoch: claim.leaseEpoch,
        },
        validateExecutionRun: () => client.heartbeat(claim),
      })
    ).id;
    await reserveSalaamWork(
      session,
      agent.hubUserId,
      claim,
      context,
      planFrom(context),
    );
    return driveSalaamWork(deps, claim.runId, session, spans);
  } catch (error) {
    if (!session) return await releaseUnopened(deps, claim, error);
    // An opened session may have durable ownership; preserve it for exact recovery.
    return {
      status: "failed",
      externalRunId: claim.runId,
      reason: String(error),
    };
  }
}

/** A startup that failed before any session: the claim is handed back, and the ledger says
 * released only when no session row was persisted for the run. */
async function releaseUnopened(
  deps: DispatchDeps,
  claim: ClaimedWork,
  error: unknown,
): Promise<DispatchResult> {
  const { agent, client } = deps;
  await client.release(claim);
  const [created] = await db
    .select({ id: acpSessions.id })
    .from(acpSessions)
    .where(
      and(
        eq(acpSessions.tenantId, deps.tenantId),
        sql`${acpSessions.executionAuthority}->'binding'->'run'->>'source' = ${deps.source}`,
        sql`${acpSessions.executionAuthority}->'binding'->'run'->>'id' = ${claim.runId}`,
      ),
    );
  if (created)
    return {
      status: "failed",
      externalRunId: claim.runId,
      reason:
        "Producer released; failed session startup requires stop-receipt reconciliation",
    };
  await markReleased(
    {
      tenantId: deps.tenantId,
      externalSource: deps.source,
      externalRunId: claim.runId,
      externalCardId: claim.card.id,
      boardId: agent.boardId,
    },
    String(error),
  );
  return {
    status: "released",
    externalRunId: claim.runId,
    reason: String(error),
  };
}
