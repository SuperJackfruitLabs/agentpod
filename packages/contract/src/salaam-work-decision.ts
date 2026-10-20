import { z } from "zod";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** A protected daemon offers one exact existing ManagedWork approval. This is
 * correlation metadata, never an independent grant or a model-generated policy. */
export const SalaamWorkDecision = z
  .object({
    version: z.literal(1),
    request_id: z.string().uuid(),
    work_request_id: z.string().uuid(),
    binding_digest: digest,
    task_id: z.string().uuid(),
    plan_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    operation_id: z.string().uuid(),
    operation_digest: digest,
    approval_id: z.string().uuid(),
    approval_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    question: z.string().min(1).max(8192),
    options: z.tuple([
      z
        .object({ id: z.literal("approve"), title: z.string().min(1).max(256) })
        .strict(),
      z
        .object({ id: z.literal("deny"), title: z.string().min(1).max(256) })
        .strict(),
    ]),
  })
  .strict();
export type SalaamWorkDecision = z.infer<typeof SalaamWorkDecision>;
/** Returned only after a verified exact producer question was answered. Expiry
 * and current operation/plan/root authority are checked again by the daemon. */
export const SalaamWorkDecisionAnswer = z
  .object({
    version: z.literal(1),
    request_id: z.string().uuid(),
    decision: SalaamWorkDecision,
    decision_digest: digest,
    elicitation_id: z
      .string()
      .regex(/^elc_[A-Za-z0-9]{6,}$/)
      .max(128),
    option_id: z.enum(["approve", "deny"]),
    answered_by: z.string().min(1).max(128),
    answered_at: z.string().datetime(),
  })
  .strict();
export type SalaamWorkDecisionAnswer = z.infer<typeof SalaamWorkDecisionAnswer>;

/** Mirror of Superpipeline's versioned strict elicitation correlation. */
export const SuperpipelineStrictDecision = z
  .object({
    version: z.literal(1),
    request_id: z.string().uuid(),
    decision_digest: digest,
    expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
