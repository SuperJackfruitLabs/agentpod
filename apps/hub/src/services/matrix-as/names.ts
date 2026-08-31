/**
 * A station's Matrix names.
 *
 * Pure, and derived from the pair that already identifies a station in a grant
 * (`charter` → decisions/2026-08-15-a-grant-names-an-agent-per-plane.md). The
 * node is in the name because station keys repeat across the fleet:
 * `opencode:c52ddf65` exists on two of them today.
 *
 * Derivation rather than a mapping table, so there is nothing to keep in sync
 * and an operator can predict a name from a station without looking it up.
 */

/**
 * Everything that is not a safe localpart character becomes `-`, lowercased.
 *
 * `_` is deliberately NOT in the kept set and is never emitted, which is what
 * makes it usable as a separator below. `:` — which every station key is full
 * of — is the main casualty, along with anything else a hostname or a harness
 * might contain.
 */
const ILLEGAL = /[^a-z0-9.=/-]/g;

const clean = (s: string): string => s.toLowerCase().replace(ILLEGAL, "-");

/**
 * `<node>_<station>`.
 *
 * One underscore, and unambiguous **by construction**: `_` cannot survive
 * cleaning, so the first one in a localpart is always the separator. An earlier
 * version kept `_` inside the halves and doubled the separator to compensate,
 * which made `a_b` + `c` and `a` + `b_c` distinct in practice but not in
 * principle — two illegal characters in a row still produced `__` inside a half.
 * Excluding `_` from the alphabet is the version that cannot collide, and it
 * reads better: `molt-bot_hermes-analyst-echo`.
 */
export function localpartFor(nodeName: string, stationKey: string): string {
  return `${clean(nodeName)}_${clean(stationKey)}`;
}

/**
 * The username to register, which is the mxid's localpart INCLUDING the
 * `agent_` prefix.
 *
 * Built from a principal's `handle`, not from where it runs. `bridgeUserId`
 * used to take `(nodeName, stationKey)`, which made an agent's chat identity a
 * function of its station: move it to another node and it became a different
 * person, with new DM rooms and its history left behind. The strategy states
 * the opposite principle twice — an agent is an identity, a station is an
 * execution location — and a principal's `handle` is immutable, so an
 * address built from it survives the move `bridgeAlias`'s room address does
 * not need to.
 *
 * Separate from a bare `clean(handle)` because registering that creates a name
 * outside the exclusive namespace the homeserver reserved, where the
 * appservice may not act. The failure arrives later and elsewhere, as a 403 at
 * send time.
 */
export function bridgeLocalpart(handle: string): string {
  return `agent_${clean(handle)}`;
}

export function bridgeUserId(handle: string, domain: string): string {
  return `@${bridgeLocalpart(handle)}:${domain}`;
}

export function bridgeAlias(nodeName: string, stationKey: string, domain: string): string {
  return `#agentpod_${localpartFor(nodeName, stationKey)}:${domain}`;
}

/**
 * A room's alias, derived from the HANDLE of whoever occupies it — fix
 * round 3 on Task 5, and the same move `bridgeUserId` already made for the
 * mxid: an occupant is an identity, a station is an execution location.
 * `bridgeAlias` above stayed station-derived, and that was the last place
 * still keyed to the station — which meant a room CREATED for a new
 * occupant reused its predecessor's exact alias, and the real homeserver's
 * only answer to "create a room at an alias that already exists" is
 * `M_ROOM_IN_USE`. `client.ts`'s `ensureRoom` handles that response two
 * ways, neither of which is "the new occupant gets its own room": if the
 * new creator happens to already be a member (harness mode, where the
 * speaker never changes with occupancy) it hands back the OLD room; if not
 * (bridge mode) it deletes the alias off the old, still-live room and
 * mints a fresh one. Deriving the alias from the occupant closes the
 * collision at the source rather than depending on either branch.
 *
 * Deliberately the SAME localpart `bridgeLocalpart` builds for the mxid
 * (`agent_<handle>`), not a new scheme — a reader (or `stations.ts`'s
 * `stationForOccupantLocalpart`) can tell a principal-derived alias apart
 * from a station-derived one on sight, since `localpartFor(nodeName,
 * stationKey)` can never itself produce a string starting `agent_` unless a
 * node is literally named "agent".
 *
 * Used only when a station HAS an occupant — `bridgeAlias` above remains
 * the address for a room with none, which is the one case a station-keyed
 * alias cannot collide with a predecessor's, because there is no
 * predecessor's room to reuse it from.
 */
export function bridgeAliasForHandle(handle: string, domain: string): string {
  return `#agentpod_${bridgeLocalpart(handle)}:${domain}`;
}

/**
 * Is this mxid one of ours?
 *
 * The first question asked of every inbound event. An Application Service is
 * sent what its own users send, and a bridge that answers those talks to itself
 * forever — the failure that fills a database overnight.
 *
 * The domain is checked as a whole label, not as a suffix: `:id.agentpod.dev`
 * must be the end of the string, or `@agent_x:id.agentpod.dev.evil.example`
 * would pass.
 */
export function isBridgeUser(mxid: string, domain: string): boolean {
  if (!mxid.endsWith(`:${domain}`)) return false;
  return mxid.startsWith("@agent_") || mxid === `@ai-bridge:${domain}`;
}
