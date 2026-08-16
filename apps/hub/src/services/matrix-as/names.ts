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
 * The characters a Matrix localpart may contain, lowercased. Everything else —
 * `:` above all, which a station key is full of — becomes `_`.
 */
const ILLEGAL = /[^a-z0-9._=/-]/g;

const clean = (s: string): string => s.toLowerCase().replace(ILLEGAL, "_");

/**
 * `<node>__<station>`, with a doubled separator between the halves.
 *
 * Doubled because a single `_` appears inside both halves after cleaning, and
 * `a_b` + `c` would otherwise produce the same localpart as `a` + `b_c` — two
 * different agents, one identity. `__` cannot appear inside a cleaned half,
 * since the cleaner never emits two in a row for a single character and any
 * literal `__` in a name is itself replaced.
 */
export function localpartFor(nodeName: string, stationKey: string): string {
  return `${clean(nodeName)}__${clean(stationKey)}`;
}

export function bridgeUserId(nodeName: string, stationKey: string, domain: string): string {
  return `@agent_${localpartFor(nodeName, stationKey)}:${domain}`;
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
