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
  /**
   * Whether the bridge's user (the station's adopter) may dispatch the station's agent, when that
   * is required: for Salaam, and for every harness while the control pair is enforced. Absent
   * when not required.
   */
  dispatchGrant?: string;
}

export interface BridgeReadinessDeps {
  strictWork(input: { stationId: string; tenantId: string; userId: string }): Promise<StrictWorkSelection>;
  stationReady(scope: { tenantId: string }, stationId: string): Promise<{ ready: boolean; reason?: string }>;
  /** The adopter's grant (dispatch-grant.ts checkBridgeDispatchGrant). Read-only. */
  dispatchGrant?(scope: { tenantId: string }, stationId: string): Promise<{ state: string }>;
  /** The control pair is enforced: every harness then needs the grant, not only Salaam. */
  pairEnforced?: boolean;
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
  if (deps.dispatchGrant && (strict.required || deps.pairEnforced)) {
    const grant = (await deps.dispatchGrant(scope, stationId)).state;
    const refusal = GRANT_REFUSALS[grant];
    if (refusal) return { ready: false, reason: refusal, checkedAt, strictWork, dispatchGrant: grant };
    const r = await deps.stationReady(scope, stationId);
    return { ready: r.ready, reason: r.ready ? null : (r.reason ?? "not ready"), checkedAt, strictWork, dispatchGrant: grant };
  }
  const r = await deps.stationReady(scope, stationId);
  return { ready: r.ready, reason: r.ready ? null : (r.reason ?? "not ready"), checkedAt, strictWork };
}

/** Grant states that stop dispatch, in words a person can act on. */
const GRANT_REFUSALS: Record<string, string> = {
  missing:
    "The bridge runs this station's cards as the person who adopted it, and they have no dispatch grant for its agent. Save the roster entry again (fleet bridge set <key> --enabled true) to record it, or grant it at the organization plane.",
  adopter_not_a_person:
    "This station was adopted by the hub's API token, not a person, so no one can hold the dispatch grant its cards need. Adopt it again as a person.",
  no_agent: "This station has no agent yet. Staff it first (fleet staff assign).",
};
