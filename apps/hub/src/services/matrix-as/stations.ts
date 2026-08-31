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
import { localpartFor, bridgeUserId } from "./names";
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
 * The station whose derived localpart is exactly this one, or null.
 *
 * For ROOM ALIASES only: `bridgeAlias`/`localpartFor` are still derived from
 * `(nodeName, stationKey)` — a room's address is not the identity occupying
 * it, and rooms are migrated separately (`charter` →
 * decisions/2026-08-30-an-agent-is-a-principal.md). Do not use this for a
 * user id; see `stationForAgentUserId` below.
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

/** `#agentpod_<localpart>:<domain>` → the localpart, or null. */
export function localpartFromAlias(alias: string, domain: string): string | null {
  const prefix = "#agentpod_";
  const suffix = `:${domain}`;
  if (!alias.startsWith(prefix) || !alias.endsWith(suffix)) return null;
  return alias.slice(prefix.length, alias.length - suffix.length) || null;
}
