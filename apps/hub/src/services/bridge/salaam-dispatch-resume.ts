/** Recovering this agent's strict runs before it claims new work. */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { bridgeDispatches } from "../../db/schema/bridge";
import {
  salaamWorkOwners,
  salaamWorkReports,
  salaamWorkDecisions,
} from "../../db/schema/salaam-work";
import { inDispatchSpan } from "../../telemetry/dispatch-span";
import { workDigest } from "../salaam";
import type { DispatchDeps, DispatchResult } from "./dispatch-types";
import { driveSalaamWork } from "./salaam-dispatch-drive";
import { exclusively } from "./salaam-dispatch-drivers";
import {
  settlementRecord,
  stoppedUnownedSession,
  verifiedSettlement,
} from "./salaam-dispatch-proofs";
import { offerParkedSettlements, parkStrictRun } from "./salaam-dispatch-stopped";

interface OwnedRow {
  session: typeof acpSessions.$inferSelect;
  dispatch: typeof bridgeDispatches.$inferSelect;
}

interface OwnerRow {
  id: string;
  settlement: unknown;
  admissionReceipt: unknown;
}

/** True while a row still holds its run; false once a verified settlement retired it. Only explicit
 * operator settlement plus its exact terminal receipt can retire a failed startup row; a generic
 * ended status is never sufficient. */
async function stillOwned(deps: DispatchDeps, row: OwnedRow): Promise<boolean> {
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
    return false;
  if (
    row.dispatch.outcome === "abandoned" &&
    stoppedUnownedSession(
      row.session,
      row.dispatch.externalRunId,
      row.dispatch.leaseEpoch,
      preservesEffects,
    )
  ) {
    if (!owner) return false;
    return !(await abandonedRetired(owner, row));
  }
  return true;
}

/** An abandoned row's settlement matches its stopped owner exactly (an expiry, its offer too). */
async function abandonedRetired(owner: OwnerRow, row: OwnedRow): Promise<boolean> {
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
    return false;
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
    return false;
  }
  if (
    retired.success &&
    retired.data.receipt &&
    "effects" in retired.data.receipt &&
    retired.data.receipt.effects === "expired_approval_unapplied"
  ) {
    const receipt = retired.data.receipt;
    if (retired.data.decision_request_id !== receipt.decision_request_id) {
      return false;
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
      return false;
    }
  }
  return Boolean(
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
  );
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
  const pending = [];
  for (const row of rows) if (await stillOwned(deps, row)) pending.push(row);
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
