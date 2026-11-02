/** Terminal recovery of a stopped strict run: the operator's settlement and the expiry protocol. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  SalaamWorkFailureReceipt,
  SalaamWorkAbandonReceipt,
  SalaamWorkExpiryReceipt,
  SalaamWorkSettlementReceipt as terminalSettlementReceipt,
} from "../../../../../packages/contract/src/salaam-work-settlement";
import { SalaamWorkPayload } from "../../../../../packages/contract/src/salaam-work-payload";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { bridgeDispatches } from "../../db/schema/bridge";
import {
  salaamWorkOwners,
  salaamWorkReports,
  salaamWorkDecisions,
} from "../../db/schema/salaam-work";
import * as broker from "../broker";
import { workDigest } from "../salaam";
import type { DispatchDeps } from "./dispatch-types";
import { settlementRecord, stoppedUnownedSession } from "./salaam-dispatch-proofs";
import type { RunContext } from "./superpipeline";

type SettleDeps = Pick<DispatchDeps, "tenantId" | "source" | "client"> & {
  agent: Pick<
    DispatchDeps["agent"],
    "key" | "boardId" | "stationId" | "hubUserId"
  >;
};

/** One settlement in progress: who asks, for which run and request, in which terminal mode. */
interface Settling {
  deps: SettleDeps;
  runId: string;
  requestId: string;
  expiredDecisionRequestId?: string;
  knownEffectsFailure: boolean;
  unreportedLocalSuccess: boolean;
}

type Owner = Awaited<ReturnType<typeof readOwner>>;

/** The exact stopped work owner of the run, or a refusal. */
async function readOwner(c: Settling) {
  const { deps, runId } = c;
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
      c.knownEffectsFailure,
    )
  )
    throw Error("Exact stopped work owner required");
  if (c.unreportedLocalSuccess) {
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
}

/** The expired, unanswered decision an expiry settlement names, or a refusal. */
async function expiredDecision(c: Settling, state: Owner) {
  const { expiredDecisionRequestId } = c;
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
      Number((expired.decision as { expires_at: unknown }).expires_at) >
        Date.now())
  )
    throw Error("Exact expired unanswered decision required");
  return expired;
}

/** Why the dispatch row is retired, by mode. */
function retireReason(c: Settling): string {
  return c.unreportedLocalSuccess
    ? "Local success preserved; revoked root retired without producer success"
    : c.knownEffectsFailure
      ? "Stopped failed work retired with known effects preserved"
      : c.expiredDecisionRequestId
        ? "Expired unanswered approval cancellation verified"
        : "Explicit never-dispatched work cancellation verified";
}

/** Why the original board run is failed, by mode. */
function failReason(c: Settling): string {
  return c.unreportedLocalSuccess
    ? "Operator retired unreported local success after execution revocation"
    : c.knownEffectsFailure
      ? "Operator retired stopped failed work with known effects preserved"
      : c.expiredDecisionRequestId
        ? "Expired unanswered approval stopped without dispatch"
        : "Operator cancelled never-dispatched stopped work";
}

/** Write the settlement record over `expected`, rechecking the stop proof; `retire` also retires
 * the dispatch row. */
async function persist(
  c: Settling,
  state: Owner,
  next: unknown,
  expected: unknown,
  retire = false,
) {
  const { deps, runId } = c;
  return db.transaction(async (tx) => {
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
        c.knownEffectsFailure,
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
          reason: retireReason(c),
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
}

/** The first settlement record: the request and its mode, no terminal, no receipt. */
function openingRecord(c: Settling) {
  return {
    version: 1,
    request_id: c.requestId,
    ...(c.expiredDecisionRequestId
      ? { decision_request_id: c.expiredDecisionRequestId }
      : {}),
    ...(c.knownEffectsFailure
      ? { known_effects_failure: true as const }
      : {}),
    ...(c.unreportedLocalSuccess
      ? { unreported_local_success: true as const }
      : {}),
    terminal: null,
    receipt: null,
  };
}

/** The original board run, ended: failed first when it is still working (a lost reply is
 * reconciled by reading it again), and refused unless it ended without success. */
async function endedOriginalRun(
  c: Settling,
  state: Owner,
  saved: z.infer<typeof settlementRecord>,
) {
  const { deps, runId } = c;
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
        failReason(c),
        async () => {
          await readOwner(c);
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
  return r;
}

/** Salaam's terminal verb for this mode, sent for the stopped owner, and its checked receipt. */
async function daemonSettlement(c: Settling, state: Owner, terminal: unknown) {
  const { requestId, expiredDecisionRequestId, knownEffectsFailure, unreportedLocalSuccess } = c;
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
  return receipt;
}

/** Terminal recovery: never-dispatched mode is explicit operator-only.
 * Expiry mode is also used by the owning controller for an exact unanswered
 * expired offer. Both require stopped ownership and an independent daemon proof. */
export async function settleNeverDispatchedSalaamWork(
  deps: SettleDeps,
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
  const c: Settling = {
    deps,
    runId,
    requestId,
    expiredDecisionRequestId,
    knownEffectsFailure,
    unreportedLocalSuccess,
  };
  let state = await readOwner(c);
  const expired = await expiredDecision(c, state);
  if (!state.w.settlement) {
    await persist(c, state, openingRecord(c), null);
    state = await readOwner(c);
  }
  let saved = settlementRecord.parse(state.w.settlement);
  if (
    saved.request_id !== requestId ||
    saved.decision_request_id !== expiredDecisionRequestId ||
    Boolean(saved.known_effects_failure) !== knownEffectsFailure ||
    Boolean(saved.unreported_local_success) !== unreportedLocalSuccess
  )
    throw Error("Original settlement request and mode required");
  const r = await endedOriginalRun(c, state, saved);
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
    await persist(c, state, next, saved);
    saved = next;
  }
  // Both read and replay remain scoped to the immutable stopped root.
  state = await readOwner(c);
  const receipt = await daemonSettlement(c, state, terminal);
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
  await persist(c, state, { ...saved, receipt }, saved, true);
  return receipt;
}
