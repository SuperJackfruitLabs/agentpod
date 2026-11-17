/** Terminal coordinator refusals the Hub reports by name. Proposed and default-off. */
import type { BenchCoordinatorResponse } from "@agentpod/contract";
import type { DispatchResult } from "./dispatch-types";

export const CAPACITY_REASON = "SuperBench capacity exhausted; the attempt stays parked and is not retried";

/**
 * A capacity refusal is terminal for the attempt on the Node: the Hub keeps the
 * same durable row, never re-sends prepare or execute, and names the cause so an
 * operator can free capacity. Every other non-completed state stays generic.
 */
export function checkpointRefusal(response: BenchCoordinatorResponse, ids: { externalRunId: string; attemptId: string }): DispatchResult | undefined {
  if (response.state !== "refused" || response.code !== "capacity_exhausted") return undefined;
  return { status: "unreported", externalRunId: ids.externalRunId, attemptId: ids.attemptId, reason: CAPACITY_REASON };
}
