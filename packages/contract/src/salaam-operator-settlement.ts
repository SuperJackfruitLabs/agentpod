import { z } from "zod";

/** Private admin recovery request. Admission grants no authority: the settlement
 * service verifies the original run, terminal evidence and exact expired decision.
 * An omitted mode preserves the existing never-dispatched operator request.
 */
export const SalaamOperatorSettlementRequest = z
  .object({
    runId: z.string().regex(/^run_[A-Za-z0-9]{6,}$/),
    requestId: z.string().uuid(),
    mode: z
      .enum([
        "never-dispatched",
        "known-effects-failure",
        "unreported-local-success",
        "expired-approval",
      ])
      .default("never-dispatched"),
    decisionRequestId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      (request.mode === "expired-approval") !==
      (request.decisionRequestId !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["decisionRequestId"],
        message:
          "decisionRequestId is required only for expired-approval settlement",
      });
  });
export type SalaamOperatorSettlementRequest = z.infer<
  typeof SalaamOperatorSettlementRequest
>;
