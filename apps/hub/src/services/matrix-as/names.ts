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
 * The address a station's room GETS — the one place that choice is made.
 *
 * Fix round 5 on Task 5. The choice between the two forms above lived
 * inline in `provision.ts`, and `routes/station-matrix.ts` made its own
 * choice — the wrong one, `bridgeAlias` unconditionally, so
 * `POST /api/stations/:id/matrix/identity` handed back an address no room
 * held for exactly the stations it can answer for at all (it 409s unless
 * there IS an occupant, and an occupant's room is addressed by
 * `bridgeAliasForHandle`). That is the same shape of miss as rounds 1-4:
 * a rule applied at one layer and re-derived, differently, at the entry
 * point in front of it. There is one rule now and both callers read it
 * through `station-room.ts`'s `roomAliasForStation`.
 *
 * `handle` null means the station has no occupant, and the station-derived
 * form is the address for a room with none — the one case it cannot
 * collide with a predecessor's, because there is no predecessor.
 */
export function roomAliasFor(
  station: { handle: string | null; nodeName: string; stationKey: string },
  domain: string
): string {
  return station.handle
    ? bridgeAliasForHandle(station.handle, domain)
    : bridgeAlias(station.nodeName, station.stationKey, domain);
}

/**
 * Who this hub speaks as in a station's room — the one place THAT choice is
 * made, for the same reason `roomAliasFor` above exists.
 *
 * It is the identity that CREATED the room, and it has to be, because that
 * is the identity the homeserver knows is registered and joined:
 *
 *  - **bridge** — the Application Service answers for the station, as its
 *    occupying agent. `provision.ts` calls `ensureUser` for exactly this
 *    localpart, so it exists.
 *  - **harness** — the station runs its own Matrix client and owns its own
 *    account, which is what `stations.matrix_id` records. `provision.ts`
 *    creates the room as that account and deliberately does NOT call
 *    `ensureUser`, since registering over an account somebody else holds is
 *    the failure the mode exists to prevent.
 *
 * The whole-branch review's Minor: `gates.ts` posted as
 * `bridgeUserId(handle)` for harness-mode stations too — an mxid nothing had
 * registered, in a room it was never a member of. The `roomAgentUser` half
 * of the same mistake was already on the record; the SEND half is worse,
 * because a read that answers the wrong name is recoverable and a send that
 * the homeserver refuses loses the gate.
 *
 * `null` — a bridge-mode station with no occupant, or a harness-mode one
 * that has never reported an mxid — is a real answer meaning "there is
 * nobody here to say this as". Never patched over with the retired
 * `(nodeName, stationKey)` form, which would put words in a station-derived
 * mouth this suite spent a slice retiring.
 */
export function stationSpeaker(
  station: { identityMode: string; harnessMxid: string | null; handle: string | null },
  domain: string
): string | null {
  if (station.identityMode !== "bridge") return station.harnessMxid;
  return station.handle ? bridgeUserId(station.handle, domain) : null;
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
