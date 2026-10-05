/**
 * Declared harness configuration — the console's client.
 *
 * Mirrors `api/plugins.ts`'s plan → review → apply-by-digest shape (the same
 * `plan` → digest → `apply` trio `fleet config` drives), but the refusal
 * lives in a different place: a plugin operation's refusal rides inside its
 * 200 body (`plan.refusal`); a declared-config plan's refusal is the HTTP
 * response itself — 400 for one that can never succeed as asked
 * (`UNKNOWN_SETTING`, `OUT_OF_SCOPE`, `CREDENTIAL_PATH`, `NOTHING_DECLARED`,
 * `OPTED_OUT`), 409 for one that lost to the state of the document or
 * station (`PLAN_STALE`, `PLAN_DIGEST_MISMATCH`, `UNREADABLE`), both
 * carrying `{error, code}`.
 *
 * `http()` (`./client`) already throws an `ApiError` for any non-2xx, and
 * `apiError()` (`./http-error`) now carries the body's `code` through onto
 * it — so a refusal reaches a caller as `ApiError.code` +
 * `ApiError.message`, never collapsed into "request failed". A 502 means
 * the node could not be reached to plan or apply anything; it is a
 * different situation with a different remedy (retry once the node is
 * back, not re-plan or re-declare) and a caller tells it apart from a
 * refusal by `ApiError.status === 502`, never by the presence of `code`
 * alone — the plan/apply route's own `NODE_UNREACHABLE` refusal rides a 502
 * WITH a code, while the operations-inspect route's "could not be reached"
 * answers one with none.
 *
 * Types come from the contract (`packages/contract/src/harness-config.ts`)
 * — imported, never redeclared — except `ConfigOptOutRow`: the opt-out
 * register's row shape is the hub's DB row (`HarnessConfigOptOutRow` in
 * `apps/hub/src/db/schema/harness-config-ops.ts`), which the contract does
 * not carry, so it is declared here to match what `GET
 * /api/fleet/config/opt-out` actually serves.
 */
import type { ConfigObservation, ConfigPlan, ConfigReceipt, ConfigSetting } from "@agentpod/contract";
import { http } from "./client";

const configPath = (stationId: string) => `/api/stations/${encodeURIComponent(stationId)}/config`;

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * GET /api/fleet/config/settings
 *
 * The union of every reachable node's registered settings. `unreachableNodes`
 * is never dropped silently — a node this tenant has that is currently
 * offline contributed nothing to `settings`, and the caller needs to know
 * that, not just see a shorter list.
 */
export const listConfigSettings = () =>
  http<{ settings: ConfigSetting[]; unreachableNodes: string[] }>("/api/fleet/config/settings");

/** GET /api/stations/:stationId/config — this station's observations, one per registered setting that applies to it. */
export const getStationConfig = (stationId: string) =>
  http<{ observations: ConfigObservation[] }>(configPath(stationId));

/**
 * POST /api/stations/:stationId/config/plan
 *
 * `value` is never sent for any entry — the hub resolves it from whatever is
 * declared for this station (its own declaration, else its node's, else the
 * fleet's); this client only ever asks "plan this setting", never "plan this
 * setting to this value".
 *
 * `settingIds` omitted mirrors `fleet config plan --station ID` with no
 * SETTING_ID: this station's current observations name every setting that
 * has something declared for it, so that is what gets planned — never an
 * empty request, and never silently narrowed to one setting's worth.
 */
export const planStationConfig = async (stationId: string, settingIds?: string[]): Promise<ConfigPlan> => {
  const ids = settingIds ?? dedupeSettingIds((await getStationConfig(stationId)).observations);
  return http<ConfigPlan>(`${configPath(stationId)}/plan`, post({ settings: ids.map((settingId) => ({ settingId })) }));
};

function dedupeSettingIds(observations: ConfigObservation[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const o of observations) {
    if (seen.has(o.settingId)) continue;
    seen.add(o.settingId);
    ids.push(o.settingId);
  }
  return ids;
}

/**
 * GET /api/stations/:stationId/config/operations/:operationId
 *
 * Re-reads the node's own record of a plan or apply without re-deriving or
 * re-planning anything (`config.inspect`) — the sibling of `plan`/`apply`.
 */
export const inspectConfigOperation = (stationId: string, operationId: string) =>
  http<ConfigReceipt>(`${configPath(stationId)}/operations/${encodeURIComponent(operationId)}`);

/**
 * POST /api/stations/:stationId/config/apply
 *
 * `planDigest` must be the digest of the plan the caller is displaying —
 * never re-derived or re-fetched here. That digest is the record that a
 * human saw this exact edit (D13); a digest that no longer matches the
 * node's recorded plan is refused (`PLAN_DIGEST_MISMATCH`), not silently
 * re-planned.
 */
export const applyStationConfig = (stationId: string, operationId: string, planDigest: string) =>
  http<ConfigReceipt>(`${configPath(stationId)}/apply`, post({ operationId, planDigest }));

/**
 * One row of the opt-out register, as `GET /api/fleet/config/opt-out`
 * serves it — the hub's `HarnessConfigOptOutRow`, timestamps serialized to
 * ISO strings over JSON. Exactly one of `stationKey`/`nodeId` is set.
 */
export interface ConfigOptOutRow {
  id: string;
  settingId: string;
  stationKey: string | null;
  nodeId: string | null;
  optedOut: boolean;
  reason: string | null;
  optedOutBy: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/fleet/config/opt-out — every exemption for this tenant, optionally narrowed to one station or node. */
export const listConfigOptOuts = (filter?: { stationKey?: string; nodeId?: string }) => {
  const params = new URLSearchParams();
  if (filter?.stationKey) params.set("stationKey", filter.stationKey);
  if (filter?.nodeId) params.set("nodeId", filter.nodeId);
  const query = params.toString();
  return http<ConfigOptOutRow[]>(`/api/fleet/config/opt-out${query ? `?${query}` : ""}`);
};
