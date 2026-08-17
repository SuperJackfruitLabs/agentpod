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
 * Separate from `localpartFor` because registering the bare name creates
 * `@prov-box__openclaw_krishna` — outside the exclusive namespace the homeserver
 * reserved, where the appservice may not act. The failure arrives later and
 * elsewhere, as a 403 at send time.
 */
export function bridgeLocalpart(nodeName: string, stationKey: string): string {
  return `agent_${localpartFor(nodeName, stationKey)}`;
}

export function bridgeUserId(nodeName: string, stationKey: string, domain: string): string {
  return `@${bridgeLocalpart(nodeName, stationKey)}:${domain}`;
}

export function bridgeAlias(nodeName: string, stationKey: string, domain: string): string {
  return `#agentpod_${localpartFor(nodeName, stationKey)}:${domain}`;
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
