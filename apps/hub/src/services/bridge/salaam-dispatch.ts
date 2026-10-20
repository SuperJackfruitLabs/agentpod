import { observeWithLease } from "./salaam-observation";
/** Strict Salaam controller selected only by a fresh private runtime probe. */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { acpSessions } from "../../db/schema/acp";
import { SalaamAuthorityStatus } from "@agentpod/contract";
import { workDigest } from "../salaam-work";
import { bridgeDispatches } from "../../db/schema/bridge";
import {
  salaamWorkOwners,
  salaamWorkReports,
} from "../../db/schema/salaam-work";
import {
  SalaamWorkPayload,
  SalaamWorkPlan,
} from "../../../../../packages/contract/src/salaam-work-payload";
import * as broker from "../broker";
import { openDispatch, markReleased } from "./ledger";
import { reserveSalaamWork, deliverSalaamWork } from "./salaam-work";
import {
  discoverSalaamDecisions,
  publishSalaamDecision,
  answerSalaamDecision,
} from "./salaam-decisions";
import { reportSalaamCompletion } from "./salaam-report";
import type { DispatchDeps, DispatchResult } from "./dispatch";
import type { ClaimedWork, RunContext } from "./superpipeline";

export interface StrictWorkSelection {
  required: boolean;
  version: 1 | null;
  reason?: string;
}
export async function probeSalaamWork(input: {
  stationId: string;
  userId: string;
}): Promise<StrictWorkSelection> {
  const [station] = await db
    .select()
    .from(stations)
    .where(
      and(eq(stations.id, input.stationId), eq(stations.userId, input.userId)),
    );
  if (!station || station.harness !== "salaam")
    return { required: false, version: null };
  const response = await broker.request(
    station.nodeId,
    "salaam.work-capability",
    {
      node_id: station.nodeId,
      station_key: station.stationKey,
      workspace: station.workspacePath,
    },
  );
  const parsed = z
    .object({ version: z.literal(1), enabled: z.literal(true) })
    .strict()
    .safeParse(response.ok ? response.data : null);
  return parsed.success
    ? { required: true, version: 1 }
    : {
        required: true,
        version: null,
        reason: "Salaam strict work version 1 is not freshly available",
      };
}
const taskSpec = z
  .object({ version: z.literal(1), plan: SalaamWorkPlan })
  .strict();
function planFrom(context: RunContext) {
  const spec = context.card.spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw Error("Strict Salaam work requires an explicit spec.salaam plan");
  return taskSpec.parse((spec as Record<string, unknown>).salaam).plan;
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function stoppedUnownedSession(
  row: typeof acpSessions.$inferSelect,
  runId: string,
  epoch: number,
): boolean {
  const a = row.executionAuthority;
  const receipt = SalaamAuthorityStatus.safeParse(a?.receipt);
  return (
    row.status === "ended" &&
    a?.state === "revoked" &&
    a.binding.run.id === runId &&
    a.binding.run.source === "superpipeline" &&
    a.binding.run.epoch === epoch &&
    a.binding.hub_session_id === row.id &&
    receipt.success &&
    receipt.data.revoked &&
    !receipt.data.authorized &&
    receipt.data.owned_execution_stopped &&
    receipt.data.unresolved_operations.length === 0 &&
    receipt.data.active_attempts.length === 0 &&
    receipt.data.interrupted_attempts.length === 0 &&
    receipt.data.session_id === a.sessionId &&
    receipt.data.admission_id === a.admissionId &&
    receipt.data.binding_digest === workDigest(a.binding) &&
    workDigest(receipt.data.binding) === workDigest(a.binding)
  );
}

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

/** Recover original owned sessions BEFORE asking the board for any new claim. */
export async function resumeSalaamWork(
  deps: DispatchDeps,
): Promise<DispatchResult | null> {
  const rows = await db
    .select({ session: acpSessions, dispatch: bridgeDispatches })
    .from(acpSessions)
    .innerJoin(
      bridgeDispatches,
      and(
        eq(bridgeDispatches.tenantId, acpSessions.tenantId),
        eq(bridgeDispatches.externalSource, "superpipeline"),
        sql`${bridgeDispatches.externalRunId} = ${acpSessions.executionAuthority} #>> '{binding,run,id}'`,
      ),
    )
    .where(
      and(
        eq(acpSessions.userId, deps.agent.hubUserId),
        eq(acpSessions.stationId, deps.agent.stationId),
        eq(acpSessions.tenantId, deps.tenantId),
        eq(bridgeDispatches.agentKey, deps.agent.key),
        eq(bridgeDispatches.boardId, deps.agent.boardId),
        sql`(${acpSessions.executionAuthority}->>'state' != 'revoked' OR ${bridgeDispatches.outcome} != 'reported')`,
      ),
    );
  // Only explicit operator settlement plus its exact terminal receipt can retire
  // a failed startup row. A generic ended status is never sufficient.
  const pending = [];
  for (const row of rows) {
    if (
      row.dispatch.outcome === "abandoned" &&
      stoppedUnownedSession(
        row.session,
        row.dispatch.externalRunId,
        row.dispatch.leaseEpoch,
      )
    ) {
      const [owner] = await db
        .select({ id: salaamWorkOwners.requestId })
        .from(salaamWorkOwners)
        .where(
          and(
            eq(salaamWorkOwners.externalSource, deps.source),
            eq(salaamWorkOwners.externalRunId, row.dispatch.externalRunId),
          ),
        );
      if (!owner) continue;
    }
    pending.push(row);
  }
  if (!pending.length) return null;
  if (pending.length !== 1)
    return {
      status: "failed",
      reason: "Multiple strict run owners require reconciliation",
    };
  const { session, dispatch } = pending[0]!;
  if (
    !session.executionAuthority ||
    session.executionAuthority.binding.run.source !== "superpipeline"
  )
    return { status: "failed", reason: "Strict run authority unavailable" };
  // Do not claim or recreate a session when a report reply may have been lost.
  return driveSalaamWork(deps, dispatch.externalRunId, session.id);
}

export async function startSalaamWork(
  deps: DispatchDeps,
  claim: ClaimedWork,
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
        and(
          eq(stations.id, agent.stationId),
          eq(stations.userId, agent.hubUserId),
          eq(stations.tenantId, deps.tenantId),
        ),
      );
    if (!station) throw Error("Strict work station ownership unavailable");
    session = (
      await acp.createSession({
        stationId: agent.stationId,
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
    return driveSalaamWork(deps, claim.runId, session);
  } catch (error) {
    if (!session) {
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
    // An opened session may have durable ownership; preserve it for exact recovery.
    return {
      status: "failed",
      externalRunId: claim.runId,
      reason: String(error),
    };
  }
}

async function driveSalaamWork(
  deps: DispatchDeps,
  runId: string,
  sessionId: string,
): Promise<DispatchResult> {
  const { agent, client, acp } = deps;
  const started = Date.now(),
    deadline = started + (deps.turnTimeoutMs ?? 30 * 60_000);
  let mustStop = false;
  const heartbeat = async (claim: { runId: string; leaseEpoch: number }) => {
    try {
      await client.heartbeat(claim);
    } catch (error) {
      if (
        ["STALE_LEASE", "NOT_RUN_OWNER"].includes(
          String((error as { code?: unknown })?.code),
        )
      )
        mustStop = true;
      throw error;
    }
  };
  try {
    const [session] = await db
      .select()
      .from(acpSessions)
      .where(
        and(
          eq(acpSessions.id, sessionId),
          eq(acpSessions.userId, agent.hubUserId),
        ),
      );
    const execution = session?.executionAuthority;
    if (!execution || execution.binding.run.id !== runId)
      throw Error("Strict session owner changed");
    const renew = async () => {
      try {
        await heartbeat({ runId, leaseEpoch: execution.binding.run.epoch });
        if (!acp.renewExecution) throw Error("Strict work renewal unavailable");
        await acp.renewExecution(
          agent.hubUserId,
          sessionId,
          execution.binding.run,
        );
      } catch (error) {
        mustStop = true;
        throw error;
      }
    };
    const observation = {
      observe: async <T>(action: () => Promise<T>) => {
        await renew();
        return observeWithLease(action, renew);
      },
      beforeReport: renew,
    };
    let [work] = await db
      .select()
      .from(salaamWorkOwners)
      .where(eq(salaamWorkOwners.sessionId, sessionId));
    if (work) {
      const [report] = await db
        .select()
        .from(salaamWorkReports)
        .where(eq(salaamWorkReports.workRequestId, work.requestId));
      if (report) {
        await reportSalaamCompletion(
          sessionId,
          agent.hubUserId,
          client,
          observation,
        );
        await acp.endSession(
          agent.hubUserId,
          sessionId,
          "Strict work reported",
        );
        return { status: "reported", externalRunId: runId };
      }
    }
    const context = await client.context(runId);
    if (
      context.run.status !== "working" ||
      context.run.leaseEpoch !== execution.binding.run.epoch
    )
      throw Error(
        "Original run is not live; no replacement claim is permitted",
      );
    const claim: ClaimedWork = {
      runId,
      leaseEpoch: context.run.leaseEpoch,
      card: context.card,
      stage: context.stage,
      handoff: context.handoff,
    };
    if (!work)
      work = await reserveSalaamWork(
        sessionId,
        agent.hubUserId,
        claim,
        context,
        planFrom(context),
      );
    const payload = SalaamWorkPayload.parse(work.payload);
    const admitted = await deliverSalaamWork(sessionId, agent.hubUserId);
    await heartbeat(claim);
    if (!acp.renewExecution) throw Error("Strict work renewal is unavailable");
    await acp.renewExecution(agent.hubUserId, sessionId, execution.binding.run);
    const progress = await broker.request(
      execution.binding.node_id,
      "salaam.work-progress",
      {
        binding: execution.binding,
        request_id: work.requestId,
        work_request_id: work.requestId,
        max_steps: payload.plan.steps.length,
        compact: false,
      },
    );
    const receipt = z
      .object({
        version: z.literal(1),
        request_id: z.literal(work.requestId),
        work_request_id: z.literal(work.requestId),
        task_id: z.literal(admitted.task_id),
        plan_revision: z.literal(admitted.plan_revision),
        binding_digest: z.literal(admitted.binding_digest),
      })
      .strict()
      .safeParse(progress.ok ? progress.data : null);
    if (!receipt.success)
      throw Error(
        "Strict bounded progression was not acknowledged; recover original request",
      );
    for (;;) {
      if (Date.now() >= deadline) {
        mustStop = true;
        throw Error("Strict work controller deadline reached");
      }
      // A board lease failure prevents renewals and every further dispatch.
      await heartbeat(claim);
      await acp.renewExecution(
        agent.hubUserId,
        sessionId,
        execution.binding.run,
      );
      const result = await observation.observe(() =>
        broker.request(
          execution.binding.node_id,
          "salaam.work-status",
          { binding: execution.binding },
          { timeoutMs: 125_000 },
        ),
      );
      const status = z
        .object({
          version: z.literal(1),
          task_id: z.string(),
          plan_revision: z.number().int().positive(),
          work_request_id: z.literal(work.requestId),
          binding_digest: z.literal(admitted.binding_digest),
          state: z.enum([
            "accepted",
            "running",
            "blocked",
            "verifying",
            "waiting_for_person",
            "waiting_for_child",
            "waiting_for_infrastructure",
            "succeeded",
            "succeeded_with_exception",
            "failed",
            "partially_completed",
            "cancelled",
          ]),
          auto_enabled: z.boolean(),
          reason: z.string().optional(),
        })
        .passthrough()
        .parse(result.ok ? result.data : null);
      if (
        status.task_id !== admitted.task_id ||
        status.plan_revision !== admitted.plan_revision
      )
        throw Error("Strict task status changed owner or plan");
      if (status.state === "succeeded") {
        await reportSalaamCompletion(
          sessionId,
          agent.hubUserId,
          client,
          observation,
        );
        await acp.endSession(
          agent.hubUserId,
          sessionId,
          "Strict work reported",
        );
        return { status: "reported", externalRunId: runId };
      }
      if (
        [
          "failed",
          "cancelled",
          "partially_completed",
          "succeeded_with_exception",
        ].includes(status.state)
      ) {
        mustStop = true;
        throw Error(
          "Strict task did not satisfy full acceptance: " + status.state,
        );
      }
      const decisions = await discoverSalaamDecisions(
        sessionId,
        agent.hubUserId,
      );
      for (const decision of decisions.decisions) {
        await publishSalaamDecision(
          sessionId,
          agent.hubUserId,
          decision,
          client,
        );
        await answerSalaamDecision(
          sessionId,
          agent.hubUserId,
          decision.request_id,
          client,
        );
      }
      if (!decisions.decisions.length && status.auto_enabled === false) {
        mustStop = true;
        throw Error(
          "Bounded progression stopped; explicit task review is required",
        );
      }
      await sleep(Math.min(deps.permissionPollMs ?? 5000, 5000));
    }
  } catch (error) {
    // Explicit revocation is attempted even on lost board lease; failures remain
    // durable owner fences and are not converted into a replacement task.
    if (mustStop)
      try {
        await acp.endSession(
          agent.hubUserId,
          sessionId,
          "Strict work stopped: " + String(error),
        );
      } catch {}
    return { status: "failed", externalRunId: runId, reason: String(error) };
  }
}
