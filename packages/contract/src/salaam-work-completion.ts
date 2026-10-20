import { z } from "zod";
/** Fresh protected verification receipt, not a model result or execution grant. */
export const SalaamWorkCompletion = z
  .object({
    version: z.literal(1),
    state: z.literal("verified"),
    work_request_id: z.string().uuid(),
    task_id: z.string().uuid(),
    plan_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    binding_digest: z.string().regex(/^[a-f0-9]{64}$/),
    completion_id: z.string().min(1).max(128),
    evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SalaamWorkCompletion = z.infer<typeof SalaamWorkCompletion>;
