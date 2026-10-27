import { createHash } from "node:crypto";
import { nextSalaamDecision } from "./salaam-decision-order";
import type { AgentSpanRecorder } from "../../telemetry/agent-spans";
import { meter } from "../../telemetry/otel";
import { recordSalaamUsage } from "../../telemetry/salaam-usage";
import { livePublisher } from "./salaam-publish-live";
import { SalaamActivityFeed } from "./salaam-activity";
import { runScopedPlan } from "./salaam-run-scope";
import { context as otelContext, trace } from "@opentelemetry/api";
import { inDispatchSpan } from "../../telemetry/dispatch-span";
import { forwardSalaamWorkTrace } from "./salaam-trace";
import {
  SalaamWorkFailureReceipt,
  SalaamWorkAbandonReceipt,
  SalaamWorkExpiryReceipt,
  SalaamWorkSettlementReceipt as terminalSettlementReceipt,
} from "../../../../../packages/contract/src/salaam-work-settlement";
import { observeWithLease } from "./salaam-observation";
/** Strict Salaam controller selected only by a fresh private runtime probe. */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { tenantScope } from "../../db/tenant-scope";
import { acpSessions } from "../../db/schema/acp";
import { SalaamAuthorityStatus } from "@agentpod/contract";
import { workDigest } from "../salaam-work";
import { bridgeDispatches } from "../../db/schema/bridge";
import {
  salaamWorkOwners,
  salaamWorkReports,
  salaamWorkDecisions,
} from "../../db/schema/salaam-work";
import {
  SalaamWorkPayload,
  SalaamWorkPlan,
} from "../../../../../packages/contract/src/salaam-work-payload";
import * as broker from "../broker";
import { createLogger } from "../../utils/logger";
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
  /** The bridge agent's workspace; the station is read only there (W4). */
  tenantId: string;
  userId: string;
}): Promise<StrictWorkSelection> {
  const [station] = await db
    .select()
    .from(stations)
    .where(tenantScope(stations, input.tenantId, eq(stations.id, input.stationId)));
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
export function planFrom(context: RunContext) {
  const spec = context.card.spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw Error("Strict Salaam work requires an explicit spec.salaam plan");
  // Each run works in its own directory and declares the agent's handoff (salaam-run-scope).
  return runScopedPlan(
    taskSpec.parse((spec as Record<string, unknown>).salaam).plan,
    context.run.runId,
  );
}
/** Extra strict progression steps for re-running a step; Salaam accepts steps or steps + this. */
export const SALAAM_RERUN_ALLOWANCE = 3;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The strict runs this hub process is driving right now. One driver per run, whatever the roster
 * says: two drivers on one run renew the same execution lease concurrently, and each renewal's
 * compare-and-set on `leaseSequence` then fails the other ("Salaam authority changed while renewal
 * was in flight"), which ends the session and strands the run (run_d187f3907dd8470c, #776).
 *
 * Taken synchronously at the point of decision, so drivers that read the ledger together still
 * cannot both pass. The ledger's transaction fences stay the cross-process guard; this is the
 * in-process one that keeps them from ever being exercised by our own loops.
 */
const drivingRuns = new Set<string>();

function busy(runId: string): DispatchResult {
  return {
    status: "idle",
    externalRunId: runId,
    reason: "Another driver in this hub owns this strict run",
  };
}

async function exclusively(
  runId: string,
  drive: () => Promise<DispatchResult>,
): Promise<DispatchResult> {
  if (drivingRuns.has(runId)) return busy(runId);
  drivingRuns.add(runId);
  try {
    return await drive();
  } finally {
    drivingRuns.delete(runId);
  }
}

function stoppedUnownedSession(
  row: typeof acpSessions.$inferSelect,
  runId: string,
  epoch: number,
  knownEffectsFailure = false,
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
    (knownEffectsFailure || receipt.data.interrupted_attempts.length === 0) &&
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

const settlementRecord = z
  .object({
    version: z.literal(1),
    request_id: z.string().uuid(),
    decision_request_id: z.string().uuid().optional(),
    known_effects_failure: z.literal(true).optional(),
    unreported_local_success: z.literal(true).optional(),
    terminal: z.unknown().nullable(),
    receipt: z
      .union([
        terminalSettlementReceipt,
        SalaamWorkExpiryReceipt,
        SalaamWorkFailureReceipt,
        SalaamWorkAbandonReceipt,
      ])
      .nullable(),
  })
  .strict();
/** Terminal recovery: never-dispatched mode is explicit operator-only.
 * Expiry mode is also used by the owning controller for an exact unanswered
 * expired offer. Both require stopped ownership and an independent daemon proof. */
export async function settleNeverDispatchedSalaamWork(
  deps: Pick<DispatchDeps, "tenantId" | "source" | "client"> & {
    agent: Pick<
      DispatchDeps["agent"],
      "key" | "boardId" | "stationId" | "hubUserId"
    >;
  },
  runId: string,
  requestId: string,
  expiredDecisionRequestId?: string,
  knownEffectsFailure = false,
  unreportedLocalSuccess = false,
) {
  z.string().uuid().parse(requestId);
  if (
    [
      knownEffectsFailure,
      unreportedLocalSuccess,
      Boolean(expiredDecisionRequestId),
    ].filter(Boolean).length > 1
  )
    throw Error("Conflicting terminal recovery modes");
  const read = async () => {
    const [w] = await db
      .select()
      .from(salaamWorkOwners)
      .where(
        and(
          eq(salaamWorkOwners.tenantId, deps.tenantId),
          eq(salaamWorkOwners.externalSource, deps.source),
          eq(salaamWorkOwners.externalRunId, runId),
        ),
      );
    const [s] = w
      ? await db
          .select()
          .from(acpSessions)
          .where(
            and(
              eq(acpSessions.id, w.sessionId),
              eq(acpSessions.userId, deps.agent.hubUserId),
              eq(acpSessions.stationId, deps.agent.stationId),
            ),
          )
      : [];
    if (
      !w ||
      !s ||
      !s.executionAuthority ||
      !stoppedUnownedSession(
        s,
        runId,
        s.executionAuthority.binding.run.epoch,
        knownEffectsFailure,
      )
    )
      throw Error("Exact stopped work owner required");
    if (unreportedLocalSuccess) {
      const [report] = await db
        .select({ id: salaamWorkReports.requestId })
        .from(salaamWorkReports)
        .where(eq(salaamWorkReports.workRequestId, w.requestId));
      if (report)
        throw Error(
          "Prepared report requires original completion reconciliation",
        );
    }
    const payload = SalaamWorkPayload.parse(w.payload);
    if (
      payload.admission.work.board_id !== deps.agent.boardId ||
      workDigest(payload.admission.binding) !==
        workDigest(s.executionAuthority.binding) ||
      !w.receipt
    )
      throw Error("Settlement owner mismatch");
    return { w, s, payload };
  };
  let state = await read();
  const [expired] = expiredDecisionRequestId
    ? await db
        .select()
        .from(salaamWorkDecisions)
        .where(
          and(
            eq(salaamWorkDecisions.requestId, expiredDecisionRequestId),
            eq(salaamWorkDecisions.workRequestId, state.w.requestId),
          ),
        )
    : [];
  if (
    expiredDecisionRequestId &&
    (!expired ||
      expired.answer ||
      expired.daemonReceipt ||
      !expired.producerReceipt ||
      Number((expired.decision as { expires_at: number }).expires_at) >
        Date.now())
  )
    throw Error("Exact expired unanswered decision required");
  const persist = async (next: unknown, expected: unknown, retire = false) =>
    db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(salaamWorkOwners)
        .where(eq(salaamWorkOwners.requestId, state.w.requestId))
        .for("update");
      if (
        !current ||
        workDigest(current.payload) !== workDigest(state.w.payload) ||
        workDigest(current.settlement) !== workDigest(expected)
      )
        throw Error("Settlement changed concurrently");
      const [session] = await tx
        .select()
        .from(acpSessions)
        .where(eq(acpSessions.id, current.sessionId))
        .for("update");
      if (
        !session ||
        !stoppedUnownedSession(
          session,
          runId,
          state.payload.admission.binding.run.epoch,
          knownEffectsFailure,
        )
      )
        throw Error("Settlement stop proof changed");
      await tx
        .update(salaamWorkOwners)
        .set({ settlement: next })
        .where(eq(salaamWorkOwners.requestId, current.requestId));
      if (retire)
        await tx
          .update(bridgeDispatches)
          .set({
            outcome: "abandoned",
            reason: unreportedLocalSuccess
              ? "Local success preserved; revoked root retired without producer success"
              : knownEffectsFailure
                ? "Stopped failed work retired with known effects preserved"
                : expiredDecisionRequestId
                  ? "Expired unanswered approval cancellation verified"
                  : "Explicit never-dispatched work cancellation verified",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(bridgeDispatches.tenantId, deps.tenantId),
              eq(bridgeDispatches.externalSource, deps.source),
              eq(bridgeDispatches.externalRunId, runId),
              eq(
                bridgeDispatches.leaseEpoch,
                state.payload.admission.binding.run.epoch,
              ),
            ),
          );
    });
  if (!state.w.settlement) {
    await persist(
      {
        version: 1,
        request_id: requestId,
        ...(expiredDecisionRequestId
          ? { decision_request_id: expiredDecisionRequestId }
          : {}),
        ...(knownEffectsFailure
          ? { known_effects_failure: true as const }
          : {}),
        ...(unreportedLocalSuccess
          ? { unreported_local_success: true as const }
          : {}),
        terminal: null,
        receipt: null,
      },
      null,
    );
    state = await read();
  }
  let saved = settlementRecord.parse(state.w.settlement);
  if (
    saved.request_id !== requestId ||
    saved.decision_request_id !== expiredDecisionRequestId ||
    Boolean(saved.known_effects_failure) !== knownEffectsFailure ||
    Boolean(saved.unreported_local_success) !== unreportedLocalSuccess
  )
    throw Error("Original settlement request and mode required");
  const verifyRun = (value: RunContext) => {
    const r = value.run,
      a = state.payload.admission;
    if (
      r.runId !== runId ||
      r.cardId !== a.work.card_id ||
      r.stageKey !== a.work.stage_key ||
      r.leaseEpoch !== a.binding.run.epoch
    )
      throw Error("Original producer run changed");
    return r;
  };
  let original = await deps.client.context(runId);
  let r = verifyRun(original);
  if (r.status === "working") {
    if (saved.terminal) throw Error("Terminal producer run revived");
    try {
      await deps.client.fail(
        { runId, leaseEpoch: r.leaseEpoch },
        unreportedLocalSuccess
          ? "Operator retired unreported local success after execution revocation"
          : knownEffectsFailure
            ? "Operator retired stopped failed work with known effects preserved"
            : expiredDecisionRequestId
              ? "Expired unanswered approval stopped without dispatch"
              : "Operator cancelled never-dispatched stopped work",
        async () => {
          await read();
        },
      );
    } catch {
      /* Lost reply must be reconciled from the original run below. */
    }
    original = await deps.client.context(runId);
    r = verifyRun(original);
  }
  if (
    r.status !== "ended" ||
    !["crashed", "released", "reclaimed"].includes(r.outcome ?? "") ||
    !r.endedAt
  )
    throw Error("Original producer non-success terminal receipt required");
  const terminal = {
    version: 1,
    board_id: deps.agent.boardId,
    run_id: r.runId,
    card_id: r.cardId,
    stage_key: r.stageKey,
    lease_epoch: r.leaseEpoch,
    status: r.status,
    outcome: r.outcome,
    ended_at: r.endedAt,
  };
  if (saved.terminal && workDigest(saved.terminal) !== workDigest(terminal))
    throw Error("Producer terminal receipt changed");
  if (!saved.terminal) {
    const next = { ...saved, terminal };
    await persist(next, saved);
    saved = next;
  }
  // Both read and replay remain scoped to the immutable stopped root.
  state = await read();
  const result = await broker.request(
    state.payload.admission.binding.node_id,
    unreportedLocalSuccess
      ? "salaam.work-abandon"
      : knownEffectsFailure
        ? "salaam.work-fail"
        : expiredDecisionRequestId
          ? "salaam.work-expire"
          : "salaam.work-settle",
    {
      binding: state.payload.admission.binding,
      request_id: requestId,
      work_request_id: state.w.requestId,
      producer_terminal_digest: workDigest(terminal),
      ...(expiredDecisionRequestId
        ? { decision_request_id: expiredDecisionRequestId }
        : {}),
    },
  );
  if (!result.ok)
    throw Error("Daemon terminal settlement unresolved; retain original owner");
  const receipt = (
      unreportedLocalSuccess
        ? SalaamWorkAbandonReceipt
        : knownEffectsFailure
          ? SalaamWorkFailureReceipt
          : expiredDecisionRequestId
            ? SalaamWorkExpiryReceipt
            : terminalSettlementReceipt
    ).parse(result.data),
    admitted = state.w.receipt as { task_id: string; plan_revision: number };
  if (
    receipt.request_id !== requestId ||
    receipt.work_request_id !== state.w.requestId ||
    receipt.session_id !== state.s.executionAuthority!.sessionId ||
    receipt.task_id !== admitted.task_id ||
    receipt.plan_revision !== admitted.plan_revision ||
    receipt.binding_digest !== workDigest(state.payload.admission.binding) ||
    receipt.producer_terminal_digest !== workDigest(terminal)
  )
    throw Error("Daemon settlement receipt mismatch");
  if (expiredDecisionRequestId) {
    const r = SalaamWorkExpiryReceipt.parse(receipt),
      d = expired!.decision as {
        approval_id: string;
        operation_digest: string;
      };
    if (
      r.decision_request_id !== expiredDecisionRequestId ||
      r.approval_id !== d.approval_id ||
      r.operation_digest !== d.operation_digest
    )
      throw Error("Expired decision receipt mismatch");
  }
  if (saved.receipt && workDigest(saved.receipt) !== workDigest(receipt))
    throw Error("Saved settlement changed");
  await persist({ ...saved, receipt }, saved, true);
  return receipt;
}

/** Expiry is a terminal non-success recovery, never a substitute answer. */
export async function recoverExpiredSalaamDecision(
  deps: DispatchDeps,
  sessionId: string,
) {
  const [work] = await db
    .select()
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.sessionId, sessionId));
  if (!work) return null;
  const decisions = await db
    .select()
    .from(salaamWorkDecisions)
    .where(eq(salaamWorkDecisions.workRequestId, work.requestId));
  const expired = decisions.filter(
    (d) =>
      !d.daemonReceipt &&
      Number((d.decision as { expires_at: number }).expires_at) <= Date.now(),
  );
  if (!expired.length) return null;
  if (expired.length !== 1 || expired[0]!.answer)
    throw Error("Expired decision recovery is ambiguous");
  const decision = expired[0]!;
  await publishSalaamDecision(
    sessionId,
    deps.agent.hubUserId,
    decision.decision,
    deps.client,
  );
  await deps.acp.endSession(
    deps.agent.hubUserId,
    sessionId,
    "Strict decision expired unanswered",
  );
  await settleNeverDispatchedSalaamWork(
    deps,
    work.externalRunId,
    decision.requestId,
    decision.requestId,
  );
  return {
    status: "failed" as const,
    externalRunId: work.externalRunId,
    reason:
      "Expired unanswered approval cancelled and original producer non-success verified",
  };
}

/** An operator settlement whose daemon receipt matches this exact stopped owner. */
function verifiedSettlement(
  owner: { id: string; settlement: unknown; admissionReceipt: unknown },
  session: typeof acpSessions.$inferSelect,
): boolean {
  const retired = settlementRecord.safeParse(owner.settlement);
  if (!retired.success || !retired.data.receipt || retired.data.terminal === null) return false;
  const r = retired.data.receipt;
  const admitted = owner.admissionReceipt as { task_id?: string; plan_revision?: number } | null;
  const effects = "effects" in r ? r.effects : undefined,
    outcome = "outcome" in r ? r.outcome : undefined;
  return (
    Boolean(retired.data.known_effects_failure) === (effects === "known_effects_preserved") &&
    Boolean(retired.data.unreported_local_success) === (outcome === "unreported_local_success") &&
    !!session.executionAuthority &&
    r.binding_digest === workDigest(session.executionAuthority.binding) &&
    r.work_request_id === owner.id &&
    r.request_id === retired.data.request_id &&
    r.session_id === session.executionAuthority.sessionId &&
    r.producer_terminal_digest === workDigest(retired.data.terminal) &&
    r.task_id === admitted?.task_id &&
    r.plan_revision === admitted?.plan_revision
  );
}

/**
 * #786: park a strict run that cannot be driven any more, so the roster can claim new work. Only the
 * transition from "working" surfaces it (card and log), so it is said once. Parking settles and
 * completes nothing: an operator settlement still reads the stopped owner and retires the row.
 */
/** The settlement's request id for one run: stable, so a retry replays the same request. */
const stoppedSettlementId = (runId: string) => {
  const h = createHash("sha256").update("stopped-known-effects:" + runId).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

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
  const binding = SalaamWorkPayload.parse(owner.payload).admission.binding;
  const status = await broker.request(binding.node_id, "salaam.work-status", { binding }, { timeoutMs: 125_000 });
  const ready = z
    .object({ work_request_id: z.literal(owner.requestId), settlement_ready: z.literal("known_effects_failure") })
    .passthrough()
    .safeParse(status.ok ? status.data : null);
  if (!ready.success) {
    // Salaam names the refusing guard (a code and fixed message) for a stopped run; say it.
    const refused = z.object({ settlement_refused: z.string().max(300) }).safeParse(status.ok ? status.data : null);
    throw Error(
      "Salaam cannot prove this stopped run's effects" +
        (refused.success
          ? ` (${refused.data.settlement_refused})`
          : !status.ok
            ? ` (status unreadable: ${String(status.error ?? "no answer").slice(0, 300)})`
            : ""),
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

async function parkStrictRun(
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
async function offerParkedSettlements(deps: DispatchDeps): Promise<void> {
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

/** Recover original owned sessions BEFORE asking the board for any new claim. */
export async function resumeSalaamWork(
  deps: DispatchDeps,
): Promise<DispatchResult | null> {
  await offerParkedSettlements(deps);
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
        // Parked (#786): classified for operator reconciliation; it no longer holds the roster.
        sql`${bridgeDispatches.outcome} != 'parked'`,
      ),
    );
  // Only explicit operator settlement plus its exact terminal receipt can retire
  // a failed startup row. A generic ended status is never sufficient.
  const pending = [];
  for (const row of rows) {
    const [owner] = await db
      .select({
        id: salaamWorkOwners.requestId,
        settlement: salaamWorkOwners.settlement,
        admissionReceipt: salaamWorkOwners.receipt,
      })
      .from(salaamWorkOwners)
      .where(
        and(
          eq(salaamWorkOwners.externalSource, deps.source),
          eq(salaamWorkOwners.externalRunId, row.dispatch.externalRunId),
        ),
      );
    const knownFailure = owner
      ? settlementRecord.safeParse(owner.settlement)
      : null;
    const preservesEffects = Boolean(
      knownFailure?.success &&
      knownFailure.data.known_effects_failure &&
      knownFailure.data.receipt &&
      "effects" in knownFailure.data.receipt &&
      knownFailure.data.receipt.effects === "known_effects_preserved",
    );

    // #786: a verified operator settlement retires the row even if its dispatch never moved off
    // "working" (run_bab4c853d6ac4f21 was re-driven forever with a settlement on record).
    if (
      owner &&
      row.dispatch.outcome !== "abandoned" &&
      verifiedSettlement(owner, row.session)
    )
      continue;
    if (
      row.dispatch.outcome === "abandoned" &&
      stoppedUnownedSession(
        row.session,
        row.dispatch.externalRunId,
        row.dispatch.leaseEpoch,
        preservesEffects,
      )
    ) {
      if (!owner) continue;
      const retired = settlementRecord.safeParse(owner.settlement);
      if (
        retired.success &&
        Boolean(retired.data.known_effects_failure) !==
          Boolean(
            retired.data.receipt &&
            "effects" in retired.data.receipt &&
            retired.data.receipt.effects === "known_effects_preserved",
          )
      ) {
        pending.push(row);
        continue;
      }
      if (
        retired.success &&
        Boolean(retired.data.unreported_local_success) !==
          Boolean(
            retired.data.receipt &&
            "outcome" in retired.data.receipt &&
            retired.data.receipt.outcome === "unreported_local_success",
          )
      ) {
        pending.push(row);
        continue;
      }
      if (
        retired.success &&
        retired.data.receipt &&
        "effects" in retired.data.receipt &&
        retired.data.receipt.effects === "expired_approval_unapplied"
      ) {
        const receipt = retired.data.receipt;
        if (retired.data.decision_request_id !== receipt.decision_request_id) {
          pending.push(row);
          continue;
        }
        const [decision] = await db
          .select()
          .from(salaamWorkDecisions)
          .where(
            and(
              eq(salaamWorkDecisions.requestId, receipt.decision_request_id),
              eq(salaamWorkDecisions.workRequestId, owner.id),
            ),
          );
        const offer = decision?.decision as
          | {
              approval_id?: string;
              operation_digest?: string;
              expires_at?: number;
            }
          | undefined;
        if (
          !decision ||
          decision.answer ||
          decision.daemonReceipt ||
          !decision.producerReceipt ||
          !offer ||
          offer.approval_id !== receipt.approval_id ||
          offer.operation_digest !== receipt.operation_digest ||
          !offer.expires_at ||
          offer.expires_at > Date.now()
        ) {
          pending.push(row);
          continue;
        }
      }
      if (
        retired.success &&
        retired.data.receipt &&
        retired.data.receipt.binding_digest ===
          workDigest(row.session.executionAuthority!.binding) &&
        retired.data.receipt.work_request_id === owner.id &&
        retired.data.receipt.request_id === retired.data.request_id &&
        retired.data.receipt.session_id ===
          row.session.executionAuthority!.sessionId &&
        retired.data.terminal !== null &&
        retired.data.receipt.producer_terminal_digest ===
          workDigest(retired.data.terminal) &&
        retired.data.receipt.task_id ===
          (owner.admissionReceipt as { task_id?: string } | null)?.task_id &&
        retired.data.receipt.plan_revision ===
          (owner.admissionReceipt as { plan_revision?: number } | null)
            ?.plan_revision
      )
        continue;
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
  return exclusively(dispatch.externalRunId, () =>
    resumeOwnedSalaamWork(deps, session, dispatch),
  );
}

async function resumeOwnedSalaamWork(
  deps: DispatchDeps,
  session: typeof acpSessions.$inferSelect,
  dispatch: typeof bridgeDispatches.$inferSelect,
): Promise<DispatchResult> {
  if (
    !session.executionAuthority ||
    session.executionAuthority.binding.run.source !== "superpipeline"
  )
    return { status: "failed", reason: "Strict run authority unavailable" };
  if (session.executionAuthority.state === "revoked") {
    const [workOwner] = await db
      .select({ id: salaamWorkOwners.requestId })
      .from(salaamWorkOwners)
      .where(eq(salaamWorkOwners.sessionId, session.id));
    const [report] = workOwner
      ? await db
          .select({ id: salaamWorkReports.requestId })
          .from(salaamWorkReports)
          .where(eq(salaamWorkReports.workRequestId, workOwner.id))
      : [];
    if (!report) {
      const reason =
        "Execution revoked before report intent; explicit original-run reconciliation required";
      const parked = await parkStrictRun(
        deps,
        dispatch.externalRunId,
        dispatch.leaseEpoch,
        reason,
        "This run stopped before it could report (its execution was revoked). It needs " +
          "operator reconciliation; nothing was completed or settled automatically.",
      );
      return {
        status: "failed",
        externalRunId: dispatch.externalRunId,
        reason: parked === "settled" ? "Stopped run settled with its known effects preserved" : reason,
      };
    }
  }
  // Do not claim or recreate a session when a report reply may have been lost.
  return inDispatchSpan(
    {
      runId: dispatch.externalRunId,
      boardId: dispatch.boardId,
      cardId: dispatch.externalCardId,
      source: dispatch.externalSource,
      stationId: session.stationId,
      startTime: new Date(),
      observation: "strict-resume",
      runEpoch: session.executionAuthority.binding.run.epoch,
      hubSessionId: session.id,
      nativeSessionId: session.executionAuthority.sessionId ?? undefined,
      countClaim: false,
    },
    (spans) => driveSalaamWork(deps, dispatch.externalRunId, session.id, spans),
  );
}

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

const workLog = createLogger("bridge");
/** Every hop of the strict Salaam work path logs at info, so a stall names its step. */
const hop = (step: string, meta: Record<string, unknown>) =>
  workLog.info("salaam work: " + step, meta);

async function driveSalaamWork(
  deps: DispatchDeps,
  runId: string,
  sessionId: string,
  spans?: AgentSpanRecorder,
): Promise<DispatchResult> {
  const { agent, client, acp } = deps;
  hop("drive", { run: runId, session: sessionId, agent: agent.key });
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
        // Its Salaam work stopped and the session ended (a failed step, an end). Re-driving it can
        // only renew a dead session forever; with no report intent it is parked like a revoked run.
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
        if (!intent) {
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
      }
    }
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
    // Verified deliverables go to SuperLibrary and the agent's handoff to the board.
    const publisher = () => {
      const publish =
        deps.salaamPublish ??
        livePublisher({
        tenantId: deps.tenantId,
        source: deps.source ?? "superpipeline",
        runId,
        leaseEpoch: execution.binding.run.epoch,
        boardId: agent.boardId,
        cardId: SalaamWorkPayload.parse(work!.payload).admission.work.card_id,
        principalId: execution.binding.principal_id,
        workRequestId: work!.requestId,
        client,
      });
      return async (completion: Parameters<typeof publish>[0]) => {
        const publication = await publish(completion);
        try {
          recordSalaamUsage(meter(), publication.usage, {
            "harness.name": "salaam",
            "run.id": runId,
            "attempt.id": work!.requestId,
            "station.id": agent.stationId,
          });
        } catch {
          /* telemetry never changes the work */
        }
        return publication;
      };
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
          publisher(),
        );
        await acp.endSession(
          agent.hubUserId,
          sessionId,
          "Strict work reported",
        );
        return { status: "reported", externalRunId: runId };
      }
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
    const payload = SalaamWorkPayload.parse(work.payload);
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
    await heartbeat(claim);
    if (!acp.renewExecution) throw Error("Strict work renewal is unavailable");
    await acp.renewExecution(agent.hubUserId, sessionId, execution.binding.run);
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
    // Tool steps reach the card as they happen, the way a streamed session's do.
    const activity = new SalaamActivityFeed(0, (event) => spans?.onEvent(event));
    for (;;) {
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
      hop("status", { run: runId, state: status.state, auto: status.auto_enabled, reason: status.reason });
      for (const step of [
        ...activity.plan((status as { plan?: unknown }).plan),
        ...activity.next((status as { activity?: unknown }).activity),
      ]) {
        try {
          await client.activity(claim, step);
        } catch {
          /* card activity is observation; it never changes the work */
        }
      }
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
          publisher(),
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
      if (!decisions.decisions.length && status.auto_enabled === false) {
        mustStop = true;
        throw Error(
          "Bounded progression stopped; explicit task review is required",
        );
      }
      await sleep(Math.min(deps.permissionPollMs ?? 5000, 5000));
    }
  } catch (error) {
    hop("failed", { run: runId, error: String(error), stopping: mustStop });
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
