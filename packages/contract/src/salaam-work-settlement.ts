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
