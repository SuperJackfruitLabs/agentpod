import { z } from "zod";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** What a person approving a strict decision is shown: the operation in plain words, each file
 * with its size and a short preview, the agent's one-line reason, and the operation digest.
 * Mirrors Superpipeline's ApprovalDetail. */
export const SalaamApprovalDetail = z
  .object({
    version: z.literal(1),
    summary: z.string().min(1).max(200),
    reason: z.string().min(1).max(300).nullable(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            change: z.enum(["create", "edit", "delete"]),
            bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
            preview: z.string().max(1200).nullable(),
          })
          .strict(),
      )
      .max(16),
    digest,
  })
  .strict();
export type SalaamApprovalDetail = z.infer<typeof SalaamApprovalDetail>;
const option = <T extends string>(id: T) =>
  z.object({ id: z.literal(id), title: z.string().min(1).max(256) }).strict();
/** Operator ruling 2026-10-28: "Always allow" sets the agent's standing workspace-write rule. Only a
 * workspace owner or admin may choose it: the board hides it from others, and the hub re-reads the
 * answerer's role from the org plane before it sets the rule and forwards the answer. */
const alwaysOption = z
  .object({ id: z.literal("always"), title: z.string().min(1).max(256), requires: z.literal("workspace-admin") })
  .strict();
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
    /** Readable approvals: what is being approved, as structured fields (never parsed from text). */
    detail: SalaamApprovalDetail.optional(),
    // approve, deny; or approve, approve-run ("Approve for this run"), deny. Nothing else.
    options: z.union([
      z.tuple([option("approve"), option("deny")]),
      z.tuple([option("approve"), option("approve-run"), option("deny")]),
      z.tuple([option("approve"), alwaysOption, option("deny")]),
      z.tuple([option("approve"), option("approve-run"), alwaysOption, option("deny")]),
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
    option_id: z.enum(["approve", "approve-run", "always", "deny"]),
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
