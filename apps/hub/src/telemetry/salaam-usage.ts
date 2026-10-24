import type { Meter } from "@opentelemetry/api";
import { ExecutionUsageEvidence } from "../../../../packages/contract/src/execution-evidence";

/**
 * Salaam's recorded usage as metrics, named after the ones Claude Code exports
 * (`claude_code.token.usage` with a `type`, `claude_code.cost.usage`), keyed to the run and
 * the admitted work. Only what Salaam's ledger recorded is counted: unknown usage is counted as
 * unknown, never as zero. Telemetry never changes the work, so a malformed value records nothing.
 */
export function recordSalaamUsage(meter: Pick<Meter, "createCounter">, value: unknown, attrs: Record<string, string>): void {
  const usage = ExecutionUsageEvidence.safeParse(value);
  if (!usage.success) return;
  const status = { ...attrs, "usage.status": usage.data.status };
  const subtotal = usage.data.recorded_subtotal;
  if (!subtotal) {
    meter.createCounter("salaam.usage.unknown", { unit: "{run}" }).add(1, status);
    return;
  }
  const tokens = meter.createCounter("salaam.token.usage", { unit: "{token}" });
  for (const [type, n] of [
    ["input", subtotal.input_tokens],
    ["output", subtotal.output_tokens],
    ["cacheRead", subtotal.cache_read_tokens],
    ["cacheCreation", subtotal.cache_write_tokens],
  ] as const)
    if (n > 0) tokens.add(n, { ...status, type });
  meter
    .createCounter("salaam.cost.usage", { unit: "USD" })
    .add(subtotal.cost_usd, { ...status, "cost.provenance": usage.data.cost_provenance });
}
