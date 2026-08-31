/**
 * From a Matrix name back to a station.
 *
 * The names are derived (`names.ts`), but the derivation is not reversible by
 * string surgery: cleaning lowercases and replaces characters, so
 * `@agent_box__hermes_a` could have come from station key `hermes:a` or
 * `hermes/a` or `hermes a`. Rather than guess, this derives the name for each of
 * the node's stations and compares — the same direction the bridge writes in, so
 * a name can never resolve to a station that would not produce it.
 *
 * The fleet is 32 stations. When it is 32,000 this becomes a stored column with
 * a unique index; it does not become a cleverer parser.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { nodes } from "../../db/schema/nodes";
import { localpartFor, bridgeUserId, bridgeLocalpart } from "./names";
import { principalHandle } from "../principals";

export interface BridgedStation {
  stationId: string;
  nodeId: string;
  nodeName: string;
  stationKey: string;
  harness: string;
  displayName: string;
  identityMode: string;
  principalId: string | null;
}

/** Every adopted station, with the node name its Matrix identity is built from. */
async function allBridgeable(): Promise<BridgedStation[]> {
  const rows = await db
    .select({
      stationId: stations.id,
      nodeId: stations.nodeId,
      nodeName: nodes.name,
      stationKey: stations.stationKey,
      harness: stations.harness,
      displayName: stations.displayName,
      identityMode: stations.matrixIdentityMode,
      principalId: stations.principalId,
    })
    .from(stations)
    .innerJoin(nodes, eq(nodes.id, stations.nodeId));
  return rows;
}

/**
 * The station whose STATION-DERIVED localpart is exactly this one, or null.
 *
 * For a room alias with NO occupant — `bridgeAlias`/`localpartFor` are still
 * derived from `(nodeName, stationKey)` for exactly that case (`names.ts`).
 * An occupied station's room alias is occupant-derived instead (fix round
 * 3, `bridgeAliasForHandle`) and resolves through
 * `stationForOccupantLocalpart` below, not this function — a station-keyed
 * lookup would never find it, since the two schemes produce different
 * strings by design. Do not use this for a user id either; see
 * `stationForAgentUserId` below.
 *
 * Null is the answer the homeserver needs for "there is nobody here" — claiming
 * every name in our namespace would let anyone conjure an agent by typing one.
 */
export async function stationForLocalpart(localpart: string): Promise<BridgedStation | null> {
  for (const s of await allBridgeable()) {
    if (localpartFor(s.nodeName, s.stationKey) === localpart) return s;
  }
  return null;
}

/**
 * The station whose CURRENT OCCUPANT's room-alias localpart is exactly this
 * one, or null — the alias counterpart to `stationForAgentUserId` below,
 * which answers the identical question for a full mxid instead.
 *
 * Fix round 3 on Task 5: once an occupied station's room alias is derived
 * from its occupant's handle (`bridgeAliasForHandle`) rather than from
 * `(nodeName, stationKey)`, resolving an inbound alias query has to try
 * this shape too, or a homeserver asking about an occupant-derived alias
 * for a station whose room does not exist yet would get no answer and
 * provisioning would never run for it.
 *
 * A station with no occupying principal has no handle and therefore no
 * occupant-derived alias to claim here — the same fail-closed rule
 * `stationForAgentUserId` already applies.
 */
export async function stationForOccupantLocalpart(localpart: string): Promise<BridgedStation | null> {
  for (const s of await allBridgeable()) {
    if (!s.principalId) continue;
    const handle = await principalHandle(s.principalId);
    if (handle && bridgeLocalpart(handle) === localpart) return s;
  }
  return null;
}

/**
 * The station whose OCCUPYING AGENT's mxid is exactly this one, or null.
 *
 * An agent's user id is built from its principal's immutable `handle` now
 * (`names.ts`'s `bridgeUserId`), not from `(nodeName, stationKey)` —
 * `stationForLocalpart` above answers a different question (a ROOM alias) and
 * would 404 forever for a real agent mxid, since a handle and a
 * `node_stationKey` pair are unrelated strings. A station with no occupying
 * principal has no handle and therefore claims no user id here, the same
 * fail-closed rule `missions.ts` and `station-matrix.ts` already apply.
 */
export async function stationForAgentUserId(
  mxid: string,
  domain: string
): Promise<BridgedStation | null> {
  for (const s of await allBridgeable()) {
    if (!s.principalId) continue;
    const handle = await principalHandle(s.principalId);
    if (handle && bridgeUserId(handle, domain) === mxid) return s;
  }
  return null;
}

/**
 * The station an inbound ROOM ALIAS names, in whichever shape it arrives —
 * the one resolver for that question, and the only one anything should use.
 *
 * Fix round 4 on Task 5. Round 3 taught `index.ts`'s `onProvisionAlias` to
 * try both shapes and left the HTTP entry point in front of it
 * (`routes/matrix-as.ts`) gating on `stationForLocalpart` alone — so an
 * occupant-derived alias for a room that does not exist yet was answered
 * `M_NOT_FOUND` at the route and the new branch was never reached for
 * exactly the shape it was added for. That is the third round running in
 * which the layer under inspection was fixed and the adjacent entry point
 * was not; a resolver both callers share is what stops there being a
 * fourth, the same way `station-room.ts` closed the station→room reads.
 *
 * Order matters: occupant-derived first, because that is the ordinary case
 * for any station with somebody in it, and station-derived second as the
 * fallback that keeps the fleet's existing rooms — created before the alias
 * followed the occupant — resolving exactly as they always have.
 */
export async function stationForAlias(
  alias: string,
  domain: string
): Promise<BridgedStation | null> {
  const localpart = localpartFromAlias(alias, domain);
  if (!localpart) return null;
  return (await stationForOccupantLocalpart(localpart)) ?? (await stationForLocalpart(localpart));
}

/** `#agentpod_<localpart>:<domain>` → the localpart, or null. */
export function localpartFromAlias(alias: string, domain: string): string | null {
  const prefix = "#agentpod_";
  const suffix = `:${domain}`;
  if (!alias.startsWith(prefix) || !alias.endsWith(suffix)) return null;
  return alias.slice(prefix.length, alias.length - suffix.length) || null;
}
