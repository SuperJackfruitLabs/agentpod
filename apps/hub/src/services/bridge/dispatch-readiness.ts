/** The readiness probe a dispatch asks before it claims. Split out of dispatch.ts, unchanged. */

import type { AcpPort } from "./dispatch-types";

/**
 * How long the readiness probe may take before the station counts as not ready.
 *
 * The probe asks a node over the broker whether its station can run work. That is a question
 * about *right now*, so a slow answer is not a useful answer — and an unbounded one is worse
 * than useless: on 2026-09-08 the bridge logged a single cycle and then nothing at all, for
 * hours, because this call never returned. The loop was neither erroring nor idling; it was
 * never coming back, which is the one failure shape that looks exactly like a quiet fleet.
 *
 * **A timed-out probe is a negative answer, not an error.** If a station cannot say it is ready
 * within ten seconds, it is not ready, and the loop's ordinary not-ready backoff is the correct
 * response. That keeps the failure inside the state machine that already handles it.
 */
export const READINESS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Bounded readiness. Deliberately narrow: this is the ONE call in a cycle that must be fast.
 *
 * The claim itself is bounded by `fetchAdapter`'s own signal, and everything after it — the
 * session, the prompt, the activity stream — is the agent's work, which legitimately takes as
 * long as it takes. Bounding the whole cycle would abandon a running agent mid-task.
 */
export async function probeReadiness(
  acp: AcpPort,
  agent: { stationId: string; hubUserId: string },
  tenantId: string,
): Promise<{ ready: boolean; reason?: string }> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ ready: boolean; reason?: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ready: false, reason: `the station did not answer a readiness probe within ${READINESS_PROBE_TIMEOUT_MS}ms` }),
      READINESS_PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      acp.stationReady({ stationId: agent.stationId, tenantId, userId: agent.hubUserId }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
