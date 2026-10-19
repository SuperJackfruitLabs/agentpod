import { z } from "zod";
import { TurnErrorKind } from "./acp-session";

/** Additive to salaam.dev/features, whose legacy strict receipt contract is unchanged. */
export const SalaamExecutionFeatures = z
  .object({
    failures: z.literal(1),
    cancellationReceipts: z.literal(1),
    toolSemantics: z.literal(1),
  })
  .strict();
export const SalaamAcpFailure = z
  .object({
    version: z.literal(1),
    kind: TurnErrorKind,
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    message: z.string().min(1).max(16384),
    sessionId: z.string().uuid().optional(),
    requestId: z.string().min(1).max(128).optional(),
    attemptId: z.string().uuid().optional(),
    provider: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(256).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    retryable: z.boolean().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type SalaamAcpFailure = z.infer<typeof SalaamAcpFailure>;
export const SalaamCancellationReceipt = z
  .object({
    version: z.literal(1),
    sessionId: z.string().uuid(),
    requestId: z.string().uuid(),
    targetRequestId: z.string().min(1).max(128).nullable(),
    attemptIds: z.array(z.string().uuid()).max(100),
    state: z.enum(["requested", "confirmed", "unknown"]),
    activeAttemptIds: z.array(z.string().uuid()).max(100),
    unresolvedOperationIds: z.array(z.string().min(1).max(256)).max(100),
    unconfirmedResources: z.array(z.string().min(1).max(256)).max(100),
  })
  .strict()
  .refine(
    (r) =>
      r.state !== "confirmed" ||
      (!r.activeAttemptIds.length &&
        !r.unresolvedOperationIds.length &&
        !r.unconfirmedResources.length),
    "Cancellation confirmation requires observed stopped resources and reconciled operations",
  );
export type SalaamCancellationReceipt = z.infer<
  typeof SalaamCancellationReceipt
>;
