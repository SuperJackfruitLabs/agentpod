import { z } from "zod";
import { SalaamAuthority } from "./salaam-authority";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SalaamWorkSettlement = z
  .object({
    binding: SalaamAuthority,
    request_id: z.string().uuid(),
    work_request_id: z.string().uuid(),
    producer_terminal_digest: hash,
  })
  .strict();
export const SalaamWorkSettlementReceipt = z
  .object({
    version: z.literal(1),
    state: z.literal("cancelled"),
    effects: z.literal("never_dispatched"),
    request_id: z.string().uuid(),
    work_request_id: z.string().uuid(),
    session_id: z.string().uuid(),
    task_id: z.string().uuid(),
    plan_revision: z.number().int().positive(),
    binding_digest: hash,
    producer_terminal_digest: hash,
  })
  .strict();

export const SalaamWorkExpiry = SalaamWorkSettlement.extend({
  decision_request_id: z.string().uuid(),
}).strict();
export const SalaamWorkExpiryReceipt = SalaamWorkSettlementReceipt.extend({
  effects: z.literal("expired_approval_unapplied"),
  decision_request_id: z.string().uuid(),
  approval_id: z.string().uuid(),
  operation_digest: hash,
}).strict();

export const SalaamWorkFailure = SalaamWorkSettlement;
export const SalaamWorkFailureReceipt = SalaamWorkSettlementReceipt.extend({
  effects: z.literal("known_effects_preserved"),
  evidence_digest: hash,
}).strict();

export const SalaamWorkAbandon = SalaamWorkSettlement;
export const SalaamWorkAbandonReceipt = SalaamWorkSettlementReceipt.omit({
  effects: true,
})
  .extend({
    state: z.literal("retired"),
    outcome: z.literal("unreported_local_success"),
    evidence_digest: hash,
  })
  .strict();
