/**
 * Is this station ready for board work, by the bridge's own test (spec 2026-10-23, C11)?
 *
 * The same two questions a dispatch cycle asks before it claims a card (dispatch.ts runOnce):
 * strict work first (a Salaam station needs `salaam.work-capability {version:1, enabled:true}`),
 * then the station's readiness gates (acp capability, node online, no unstopped Salaam run).
 * Before this, the only place to read the answer was the hub's log.
 */
import type { StrictWorkSelection } from "./salaam-dispatch";

export interface BridgeReadiness {
  ready: boolean;
  /** Why not, in the words the bridge logs. Null when ready. */
  reason: string | null;
  checkedAt: string;
  /** Whether the station needs Salaam strict work, and which version answered (null: none). */
  strictWork: { required: boolean; version: 1 | null };
}

export interface BridgeReadinessDeps {
  strictWork(input: { stationId: string; tenantId: string; userId: string }): Promise<StrictWorkSelection>;
  stationReady(scope: { tenantId: string }, stationId: string): Promise<{ ready: boolean; reason?: string }>;
  now?: () => Date;
}

export async function bridgeReadiness(
  scope: { tenantId: string },
  stationId: string,
  deps: BridgeReadinessDeps,
): Promise<BridgeReadiness> {
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const strict = await deps.strictWork({ stationId, tenantId: scope.tenantId, userId: "" });
  const strictWork = { required: strict.required, version: strict.version };
  if (strict.required && strict.version !== 1) {
    return { ready: false, reason: strict.reason ?? "Strict work protocol unavailable", checkedAt, strictWork };
  }
  const r = await deps.stationReady(scope, stationId);
  return { ready: r.ready, reason: r.ready ? null : (r.reason ?? "not ready"), checkedAt, strictWork };
}
