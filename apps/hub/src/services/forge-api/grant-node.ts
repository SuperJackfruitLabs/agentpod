/**
 * What the hub asks a node about a station before it mints: the `forge.api.status` call (the stk
 * handover key and isolation), the verbs' timeouts, and the node's coded refusals.
 */
import { VERB_PARAMS, VERB_RESULTS } from "@agentpod/contract";

import { ForgeApiGrantError, type ForgeApiGrantErrorCode } from "./errors";
import { scrub } from "./grant-common";
import type { BrokerReply, ForgeApiDeps, StationRow } from "./grant-types";

/**
 * The hub's timeout for `forge.api.verify`. The node's bypass probe can take up to 45 s, the
 * harness's own probe up to 10 s more, then stk's verify call to the forge: 90 s covers all three
 * with margin. The broker's default (15 s) would turn every probing verify into "offline".
 * A verify holds the grant's claim (one of CLAIM_CAP slots) for that long; reconcile runs grants
 * one at a time and verifies only rotating or verify-pending rows, so it holds at most one slot.
 */
export const FORGE_VERIFY_TIMEOUT_MS = 90_000;
/**
 * `forge.api.status` and `forge.api.deliver` may be the node's FIRST touch of a station: it then
 * creates the station's stk instance (install, systemd unit, doctor) before answering. The broker's
 * 15 s default would read that as "timeout". A node that is already installing answers
 * `station-instance-preparing` at once instead (retryable, see NODE_PREPARING).
 */
export const FORGE_STATUS_TIMEOUT_MS = 120_000;
export const FORGE_DELIVER_TIMEOUT_MS = 120_000;

/** The node's coded error for an stk install already in flight: retry later, nothing failed. */
export const NODE_PREPARING = "station-instance-preparing";
/**
 * Node codes that refuse the station outright (`<code>: <detail>`). The hub keeps the code and
 * replaces the node's detail with fixed text; the route answers 409 with the code.
 */
export const NODE_REFUSALS: Record<string, string> = {
  "station-not-hosted": "the node does not host this station",
  "station-key-changed": "the station's key changed on the node; prune its instance there first",
  "station-uid-shared": "stations on the node share an agent uid; map uids per station or acknowledge it on the node",
  "stk-unavailable": "forge API access is not configured or is disabled on the node",
};
/** The stable code a node error starts with (`code: detail`), or null. */
export function nodeCode(error: string): string | null {
  const m = /^([a-z][a-z0-9-]*):/.exec(error.trim());
  return m ? m[1]! : null;
}

/** Retryable transport failures: the frame may never have reached the node. */
export const TRANSIENT = new Set(["node offline", "timeout", "node disconnected"]);

/**
 * Ask the node for the station's stk handover public key (`forge.api.status` → `publicKey`).
 * An offline node, an old node that does not know the verb, or one that answers without a key is
 * `station-key-unavailable` (502): the hub cannot seal, so it must not mint.
 */
export async function fetchStationPublicKey(
  deps: Pick<ForgeApiDeps, "broker">,
  station: { id: string; nodeId: string },
): Promise<string> {
  return (await fetchStationStatus(deps, station)).publicKey;
}

/**
 * The status call, with what it says about isolation. The node reports isolation per grant it
 * holds, not per station, so `separateUser` is true only when it holds grants and every one is
 * `separate-user`; anything else (no grants, any same-user) is treated as same-user (fail closed).
 */
async function fetchStationStatus(
  deps: Pick<ForgeApiDeps, "broker">,
  station: { id: string; nodeId: string },
): Promise<{ publicKey: string; separateUser: boolean }> {
  const params = VERB_PARAMS["forge.api.status"].parse({ stationId: station.id });
  const unavailable = (why: string) =>
    new ForgeApiGrantError("station-key-unavailable", `station ${station.id}: no stk handover key (${why}).`);
  let res: BrokerReply;
  try {
    res = await deps.broker.request(station.nodeId, "forge.api.status", params, { timeoutMs: FORGE_STATUS_TIMEOUT_MS });
  } catch (err) {
    throw unavailable(scrub(err));
  }
  if (!res.ok) {
    const code = nodeCode(res.error ?? "");
    if (code === NODE_PREPARING) {
      throw new ForgeApiGrantError("station-preparing", `station ${station.id}: the node is preparing its broker; retry shortly.`);
    }
    if (code && NODE_REFUSALS[code]) {
      throw new ForgeApiGrantError(code as ForgeApiGrantErrorCode, `station ${station.id}: ${NODE_REFUSALS[code]}.`);
    }
    throw unavailable(scrub(res.error ?? "node error"));
  }
  const parsed = VERB_RESULTS["forge.api.status"].safeParse(res.data);
  if (!parsed.success) throw unavailable("unreadable status reply");
  if (!parsed.data.publicKey) throw unavailable("the node did not report one");
  const grants = parsed.data.grants;
  return {
    publicKey: parsed.data.publicKey,
    separateUser: grants.length > 0 && grants.every((x) => x.isolation === "separate-user"),
  };
}

export async function stationPublicKey(deps: ForgeApiDeps, station: StationRow): Promise<string> {
  return (await stationStatus(deps, station)).publicKey;
}

export async function stationStatus(deps: ForgeApiDeps, station: StationRow): Promise<{ publicKey: string; separateUser: boolean }> {
  // An injected key lookup says nothing about isolation: same-user (fail closed).
  if (deps.stationPublicKey) return { publicKey: await deps.stationPublicKey({ id: station.id, nodeId: station.nodeId }), separateUser: false };
  return fetchStationStatus(deps, { id: station.id, nodeId: station.nodeId });
}
