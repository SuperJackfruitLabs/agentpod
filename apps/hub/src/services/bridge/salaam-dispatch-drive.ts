/** Driving one strict Salaam run: admission, the bounded progression grant, and the status loop. */
import { context as otelContext, trace } from "@opentelemetry/api";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { SalaamWorkPayload } from "../../../../../packages/contract/src/salaam-work-payload";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { salaamWorkOwners, salaamWorkReports } from "../../db/schema/salaam-work";
import type { AgentSpanRecorder } from "../../telemetry/agent-spans";
import { meter } from "../../telemetry/otel";
import { recordSalaamUsage } from "../../telemetry/salaam-usage";
import * as broker from "../broker";
import { superlibraryClient } from "../superlibrary";
import type { AcpPort, DispatchDeps, DispatchResult } from "./dispatch-types";
import { SalaamActivityFeed } from "./salaam-activity";
import { serveSalaamBoardReads } from "./salaam-board-reads";
import { nextSalaamDecision } from "./salaam-decision-order";
import {
  discoverSalaamDecisions,
  publishSalaamDecision,
  answerSalaamDecision,
} from "./salaam-decisions";
import { recoverExpiredSalaamDecision } from "./salaam-dispatch-expired";
import { hop } from "./salaam-dispatch-log";
import { SALAAM_RERUN_ALLOWANCE, planFrom } from "./salaam-dispatch-plan";
import { parkStrictRun } from "./salaam-dispatch-stopped";
import { observeWithLease } from "./salaam-observation";
import { livePublisher } from "./salaam-publish-live";
import { reportSalaamCompletion } from "./salaam-report";
import { forwardSalaamWorkTrace } from "./salaam-trace";
import { reserveSalaamWork, deliverSalaamWork } from "./salaam-work";
import type { ClaimedWork } from "./superpipeline";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One drive of a run: what it was given, its deadline, and whether a failure must stop it. */
interface Drive {
  deps: DispatchDeps;
  runId: string;
  sessionId: string;
  spans?: AgentSpanRecorder;
  deadline: number;
  mustStop: boolean;
}

/** A drive whose session holds the run's execution authority. */
interface Held extends Drive {
  execution: StoredSalaamExecution;
  observation: {
    observe<T>(action: () => Promise<T>): Promise<T>;
    beforeReport(): Promise<void>;
  };
}

type StoredSalaamExecution = NonNullable<(typeof acpSessions.$inferSelect)["executionAuthority"]>;
type WorkOwner = typeof salaamWorkOwners.$inferSelect;
/** The ACP port once it is known to renew execution. */
type RenewingPort = AcpPort & { renewExecution: NonNullable<AcpPort["renewExecution"]> };

function canRenew(acp: AcpPort): acp is RenewingPort {
  return typeof acp.renewExecution === "function";
}
type Admitted = Awaited<ReturnType<typeof deliverSalaamWork>>;

/** A board lease failure (stale or foreign) means the work must stop. */
async function heartbeat(d: Drive, claim: { runId: string; leaseEpoch: number }) {
  try {
    await d.deps.client.heartbeat(claim);
  } catch (error) {
    if (
      ["STALE_LEASE", "NOT_RUN_OWNER"].includes(
        String((error as { code?: unknown })?.code),
      )
    )
      d.mustStop = true;
    throw error;
  }
}

async function renew(h: Held) {
  const { deps, runId, sessionId, execution } = h;
  try {
    await heartbeat(h, { runId, leaseEpoch: execution.binding.run.epoch });
    if (!deps.acp.renewExecution) throw Error("Strict work renewal unavailable");
    await deps.acp.renewExecution(
      deps.agent.hubUserId,
      sessionId,
      execution.binding.run,
    );
  } catch (error) {
    h.mustStop = true;
    throw error;
  }
}

// Verified deliverables go to SuperLibrary and the agent's handoff to the board.
function publisher(h: Held, work: WorkOwner) {
  const { deps, runId, execution } = h;
  const { agent, client } = deps;
  const publish =
    deps.salaamPublish ??
    livePublisher({
    tenantId: deps.tenantId,
    source: deps.source ?? "superpipeline",
    runId,
    leaseEpoch: execution.binding.run.epoch,
    boardId: agent.boardId,
    cardId: SalaamWorkPayload.parse(work.payload).admission.work.card_id,
    principalId: execution.binding.principal_id,
    workRequestId: work.requestId,
    client,
  });
  return async (completion: Parameters<typeof publish>[0]) => {
    const publication = await publish(completion);
    try {
      recordSalaamUsage(meter(), publication.usage, {
        "harness.name": "salaam",
        "run.id": runId,
        "attempt.id": work.requestId,
        "station.id": agent.stationId,
      });
    } catch {
      /* telemetry never changes the work */
    }
    return publication;
  };
}

/** Report the verified completion and end the session: the run is done. */
async function reported(h: Held, work: WorkOwner): Promise<DispatchResult> {
  const { deps, runId, sessionId } = h;
  await reportSalaamCompletion(
    sessionId,
    deps.agent.hubUserId,
    deps.client,
    h.observation,
    publisher(h, work),
  );
  await deps.acp.endSession(
    deps.agent.hubUserId,
    sessionId,
    "Strict work reported",
  );
  return { status: "reported", externalRunId: runId };
}

/** The session's execution, held again after a hub restart; a result when it cannot be driven. */
async function holdSession(d: Drive): Promise<StoredSalaamExecution | DispatchResult> {
  const { deps, runId, sessionId } = d;
  const { agent, acp } = deps;
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
  // A hub restart leaves the session un-held: bring it back before driving, and never drive
  // (deliver, renew, publish) while its node is not connected.
  if (acp.ensureStrictSession) {
    const held = await acp.ensureStrictSession(agent.hubUserId, sessionId);
    if (held === "waiting")
      return {
        status: "idle",
        externalRunId: runId,
        reason: "Strict session is waiting for its station node to reconnect",
      };
    if (held === "gone") {
      const parked = await parkGone(d, execution);
      if (parked) return parked;
    }
  }
  return execution;
}

/** A gone session: its Salaam work stopped and the session ended (a failed step, an end).
 * Re-driving it can only renew a dead session forever; with no report intent it is parked like
 * a revoked run. Null when it has a report intent, which the report path keeps. */
async function parkGone(d: Drive, execution: StoredSalaamExecution): Promise<DispatchResult | null> {
  const { deps, runId, sessionId } = d;
  const [owner] = await db
    .select({ id: salaamWorkOwners.requestId })
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.sessionId, sessionId));
  const [intent] = owner
    ? await db
        .select({ id: salaamWorkReports.requestId })
        .from(salaamWorkReports)
        .where(eq(salaamWorkReports.workRequestId, owner.id))
    : [];
  if (intent) return null;
  const reason =
    "Strict session ended before report intent; explicit original-run reconciliation required";
  const parked = await parkStrictRun(
    deps,
    runId,
    execution.binding.run.epoch,
    reason,
    "This run's session ended before it could report (its work stopped). It needs " +
      "operator review; nothing was completed or settled automatically.",
  );
  return {
    status: "failed",
    externalRunId: runId,
    reason: parked === "settled" ? "Stopped run settled with its known effects preserved" : reason,
  };
}

/** Deliver the work (its saved owner, or one reserved now) and record its admitted identities. */
async function admit(h: Held, claim: ClaimedWork, work: WorkOwner): Promise<Admitted> {
  const { deps, runId, sessionId, execution, spans } = h;
  const { agent } = deps;
  hop("deliver", { run: runId, work: work.requestId });
  const admitted = await deliverSalaamWork(sessionId, agent.hubUserId);
  hop("admitted", { run: runId, task: admitted.task_id, plan: admitted.plan_revision });
  try {
    spans?.openAttempt({
      attemptId: work.requestId,
      sessionId,
      startSeq: 0,
      fingerprintDigest: admitted.binding_digest,
      harnessName: "salaam",
    });
  } catch {
    /* products never block on telemetry */
  }
  // These are saved/admitted identities, not new telemetry-owned attempts.
  try {
    trace.getSpan(otelContext.active())?.setAttributes({
      "hub.session.id": sessionId,
      "salaam.session.id": admitted.session_id,
      "task.id": admitted.task_id,
      "run.epoch": execution.binding.run.epoch,
    });
  } catch {
    /* telemetry cannot change execution authority */
  }
  await heartbeat(h, claim);
  return admitted;
}

/** Forward the trace context to Salaam, and note on the owner whether it was recorded. */
async function recordTrace(h: Held, work: WorkOwner) {
  const { runId, execution } = h;
  const telemetryStatus = await forwardSalaamWorkTrace(execution.binding);
  hop("trace", { run: runId, status: telemetryStatus });
  if (telemetryStatus !== "unreported") {
    // This optional ledger write cannot turn a telemetry outage into task failure.
    try {
      await db
        .update(salaamWorkOwners)
        .set({ telemetryStatus })
        .where(
          and(
            eq(salaamWorkOwners.requestId, work.requestId),
            eq(salaamWorkOwners.tenantId, work.tenantId),
          ),
        );
    } catch {
      /* execution remains independent */
    }
  }
}

/** Ask Salaam for the bounded progression this plan is funded for, and check its receipt. */
async function grantProgress(h: Held, work: WorkOwner, admitted: Admitted) {
  const { runId, execution } = h;
  const payload = SalaamWorkPayload.parse(work.payload);
  const progress = await broker.request(
    execution.binding.node_id,
    "salaam.work-progress",
    {
      binding: execution.binding,
      request_id: work.requestId,
      work_request_id: work.requestId,
      // The plan's steps plus the capped re-run allowance: it funds re-running a rate-limited
      // or reopened step only, since every step completes once (Salaam refuses any other count).
      max_steps: payload.plan.steps.length + SALAAM_RERUN_ALLOWANCE,
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
  if (!receipt.success) {
    hop("progress refused", {
      run: runId,
      ok: progress.ok,
      error: progress.ok ? "receipt did not match" : String((progress as { error?: unknown }).error),
    });
    throw Error(
      "Strict bounded progression was not acknowledged; recover original request",
    );
  }
  hop("progress acknowledged", { run: runId, steps: payload.plan.steps.length });
}

/** One status read, renewed first, and the board reads it asks for. */
async function readStatus(h: Held, acp: RenewingPort, claim: ClaimedWork, work: WorkOwner, admitted: Admitted) {
  const { deps, runId, sessionId, execution } = h;
  const { agent, client } = deps;
  // A board lease failure prevents renewals and every further dispatch.
  await heartbeat(h, claim);
  await acp.renewExecution(
    agent.hubUserId,
    sessionId,
    execution.binding.run,
  );
  const result = await h.observation.observe(() =>
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
  hop("status", { run: runId, state: status.state, auto: status.auto_enabled, reason: status.reason });
  // Board reads the agent is waiting on, served here with the hub's own clients and scoped to
  // this run's card and board (operator ruling 2026-10-28). No credential goes to the station.
  await serveSalaamBoardReads({
    status: result.ok ? result.data : null,
    binding: execution.binding,
    run: { runId, cardId: claim.card.id, boardId: client.board },
    agentPrincipal: execution.binding.principal_id,
    sp: client,
    library: superlibraryClient(),
    send: (payload) => broker.request(execution.binding.node_id, "salaam.work-read", payload),
    log: hop,
  });
  return status;
}

/** Publish and answer the next pending decision, one at a time; a result when one expired. */
async function decide(h: Held, autoEnabled: boolean): Promise<DispatchResult | null> {
  const { deps, sessionId } = h;
  const { agent, client } = deps;
  const decisions = await discoverSalaamDecisions(
    sessionId,
    agent.hubUserId,
  );
  const expiredRecovery = await recoverExpiredSalaamDecision(
    deps,
    sessionId,
  );
  if (expiredRecovery) return expiredRecovery;
  // One question at a time: a board holds one per run, and a second cancels the first.
  const next = nextSalaamDecision(decisions.decisions);
  for (const decision of next ? [next] : []) {
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
  if (!decisions.decisions.length && autoEnabled === false) {
    h.mustStop = true;
    throw Error(
      "Bounded progression stopped; explicit task review is required",
    );
  }
  return null;
}

/** One pass of the status loop: a result when the run is done, null to poll again. */
async function poll(
  h: Held,
  acp: RenewingPort,
  claim: ClaimedWork,
  work: WorkOwner,
  admitted: Admitted,
  activity: SalaamActivityFeed,
): Promise<DispatchResult | null> {
  const { deps, runId } = h;
  // A rebuilt loop takes this run over. Safe here: no renewal or observation is in flight,
  // and the durable owner is left exactly as it is for the successor's resume.
  if (deps.handover?.aborted) {
    hop("handed over", { run: runId });
    return {
      status: "failed",
      externalRunId: runId,
      reason: "Strict work handed over to the rebuilt loop",
    };
  }
  if (Date.now() >= h.deadline) {
    h.mustStop = true;
    throw Error("Strict work controller deadline reached");
  }
  const status = await readStatus(h, acp, claim, work, admitted);
  for (const step of [
    ...activity.plan((status as { plan?: unknown }).plan),
    ...activity.next((status as { activity?: unknown }).activity),
  ]) {
    try {
      await deps.client.activity(claim, step);
    } catch {
      /* card activity is observation; it never changes the work */
    }
  }
  if (
    status.task_id !== admitted.task_id ||
    status.plan_revision !== admitted.plan_revision
  )
    throw Error("Strict task status changed owner or plan");
  if (status.state === "succeeded") return reported(h, work);
  if (
    [
      "failed",
      "cancelled",
      "partially_completed",
      "succeeded_with_exception",
    ].includes(status.state)
  ) {
    h.mustStop = true;
    throw Error(
      "Strict task did not satisfy full acceptance: " + status.state,
    );
  }
  return decide(h, status.auto_enabled);
}

/** Everything a drive does inside its failure guard. */
async function driveHeld(d: Drive): Promise<DispatchResult> {
  const { deps, runId, sessionId } = d;
  const { agent, client } = deps;
  const execution = await holdSession(d);
  if ("status" in execution) return execution;
  // The drive itself becomes the held drive, so a stop flagged anywhere is the one its guard reads.
  const h: Held = Object.assign(d, {
    execution,
    observation: {
      observe: async <T>(action: () => Promise<T>) => {
        await renew(h);
        return observeWithLease(action, () => renew(h));
      },
      beforeReport: () => renew(h),
    },
  });
  let [work] = await db
    .select()
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.sessionId, sessionId));
  if (work) {
    const [report] = await db
      .select()
      .from(salaamWorkReports)
      .where(eq(salaamWorkReports.workRequestId, work.requestId));
    if (report) return reported(h, work);
  }
  const expiredRecovery = await recoverExpiredSalaamDecision(deps, sessionId);
  if (expiredRecovery) return expiredRecovery;
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
  const admitted = await admit(h, claim, work);
  const { acp } = deps;
  if (!canRenew(acp)) throw Error("Strict work renewal is unavailable");
  await acp.renewExecution(agent.hubUserId, sessionId, execution.binding.run);
  await recordTrace(h, work);
  await grantProgress(h, work, admitted);
  // Tool steps reach the card as they happen, the way a streamed session's do.
  const activity = new SalaamActivityFeed(0, (event) => d.spans?.onEvent(event));
  for (;;) {
    const done = await poll(h, acp, claim, work, admitted, activity);
    if (done) return done;
    await sleep(Math.min(deps.permissionPollMs ?? 5000, 5000));
  }
}

export async function driveSalaamWork(
  deps: DispatchDeps,
  runId: string,
  sessionId: string,
  spans?: AgentSpanRecorder,
): Promise<DispatchResult> {
  const { agent, acp } = deps;
  hop("drive", { run: runId, session: sessionId, agent: agent.key });
  const started = Date.now(),
    deadline = started + (deps.turnTimeoutMs ?? 30 * 60_000);
  const d: Drive = { deps, runId, sessionId, spans, deadline, mustStop: false };
  try {
    return await driveHeld(d);
  } catch (error) {
    hop("failed", { run: runId, error: String(error), stopping: d.mustStop });
    // Explicit revocation is attempted even on lost board lease; failures remain
    // durable owner fences and are not converted into a replacement task.
    if (d.mustStop)
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
