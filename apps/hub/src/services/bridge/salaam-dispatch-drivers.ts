/** One driver per strict run in this hub process. */
import type { DispatchResult } from "./dispatch-types";

/**
 * The strict runs this hub process is driving right now. One driver per run, whatever the roster
 * says: two drivers on one run renew the same execution lease concurrently, and each renewal's
 * compare-and-set on `leaseSequence` then fails the other ("Salaam authority changed while renewal
 * was in flight"), which ends the session and strands the run (run_d187f3907dd8470c, #776).
 *
 * Taken synchronously at the point of decision, so drivers that read the ledger together still
 * cannot both pass. The ledger's transaction fences stay the cross-process guard; this is the
 * in-process one that keeps them from ever being exercised by our own loops.
 */
const drivingRuns = new Set<string>();

function busy(runId: string): DispatchResult {
  return {
    status: "idle",
    externalRunId: runId,
    reason: "Another driver in this hub owns this strict run",
  };
}

export async function exclusively(
  runId: string,
  drive: () => Promise<DispatchResult>,
): Promise<DispatchResult> {
  if (drivingRuns.has(runId)) return busy(runId);
  drivingRuns.add(runId);
  try {
    return await drive();
  } finally {
    drivingRuns.delete(runId);
  }
}
