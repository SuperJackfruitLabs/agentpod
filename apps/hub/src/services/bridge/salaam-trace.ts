import { z } from "zod";
import type { SalaamAuthority } from "../../../../../packages/contract/src/salaam-authority";
import { traceMeta } from "../../telemetry/propagation";
import * as broker from "../broker";
const receipt = z
  .object({
    version: z.literal(1),
    traceparent: z
      .string()
      .regex(/^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-[a-f0-9]{2}$/),
    authority: z.literal(false),
  })
  .strict();
/** Optional correlation only. Failure cannot affect execution or renew authority. */
export async function forwardSalaamWorkTrace(
  binding: SalaamAuthority,
): Promise<"unreported" | "recorded" | "unavailable"> {
  const meta = traceMeta();
  if (!meta) return "unreported";
  try {
    const result = await broker.request(
      binding.node_id,
      "salaam.work-trace",
      { binding, traceparent: meta.traceparent },
      { timeoutMs: 5000 },
    );
    return result.ok && receipt.safeParse(result.data).success
      ? "recorded"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** A saved correlation receipt proves no collector delivery. Keep the two facts distinct. */
export function traceDeliveryEvidence(saved: unknown): {
  trace_context_status: "recorded" | "unavailable" | "unreported";
  telemetry_status: "delivery_unconfirmed" | "unavailable" | "unreported";
} {
  if (saved === "recorded")
    return {
      trace_context_status: "recorded",
      telemetry_status: "delivery_unconfirmed",
    };
  if (saved === null || saved === undefined || saved === "unreported")
    return {
      trace_context_status: "unreported",
      telemetry_status: "unreported",
    };
  return {
    trace_context_status: "unavailable",
    telemetry_status: "unavailable",
  };
}
