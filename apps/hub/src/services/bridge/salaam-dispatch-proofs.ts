/** The pure proofs a strict run's recovery reads: a stopped owner, a settlement and its receipt. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { SalaamAuthorityStatus } from "@agentpod/contract";
import {
  SalaamWorkFailureReceipt,
  SalaamWorkAbandonReceipt,
  SalaamWorkExpiryReceipt,
  SalaamWorkSettlementReceipt as terminalSettlementReceipt,
} from "../../../../../packages/contract/src/salaam-work-settlement";
import type { acpSessions } from "../../db/schema/acp";
import { workDigest } from "../salaam";

export function stoppedUnownedSession(
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

export const settlementRecord = z
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

/** An operator settlement whose daemon receipt matches this exact stopped owner. */
export function verifiedSettlement(
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

/** The settlement's request id for one run: stable, so a retry replays the same request. */
export const stoppedSettlementId = (runId: string) => {
  const h = createHash("sha256").update("stopped-known-effects:" + runId).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
