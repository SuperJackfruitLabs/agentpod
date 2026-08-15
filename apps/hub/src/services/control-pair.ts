/**
 * The control pair: who may dispatch which agent, and who may grant an agent
 * its reach.
 *
 * Decision 4 of charter decisions/2026-08-13-ecosystem-identity.md. Because
 * agents hold their own reach rather than authority delegated per run, these two
 * checks carry the weight that delegation would otherwise have carried — and
 * **both** are required. Dispatch control alone is decorative: anyone who can
 * register an agent and grant it production credentials does not need permission
 * to dispatch anything, because they build the agent they want.
 *
 * ## Where this is enforced, and why here
 *
 * At `acp.createSession`, which is the one choke point both paths pass through —
 * the console/API route and the kaambaan bridge's dispatch. That matters: the
 * decision is explicit that a check living only in kaambaan would cover
 * board-driven work while the most common path today, provisioning straight at
 * AgentPod, went unguarded. "A control with a hole that shape is not a control."
 *
 * ## Static configuration, in the shape of the eventual claim
 *
 * The Organization plane is authoritative for the grant and does not exist. The
 * decision blesses an interim where the grant lives as static configuration in
 * each plane **provided it is the same shape as the eventual claim**, so that
 * adopting a real issuer is a data move rather than a redesign. The names here
 * are the ones already reserved in
 * `fixtures/ecosystem-identity/token_claims.json`: `mayDispatch`,
 * `mayGrantReach`.
 *
 * ## Two postures, deliberately different
 *
 * **Unconfigured is off.** Introducing the first real authorization check in
 * this suite must not be the same event as switching it on across a live fleet.
 * An unset `CONTROL_PAIR_GRANTS` means the check does not run — the same posture
 * `HUB_ISSUER` and the tenant external mapping take, and the reason a standalone
 * hub keeps working.
 *
 * **Configured is fail-closed.** Once grants exist, a principal with no grant is
 * refused. Absence is never permission; that is the decision's own wording and
 * the whole point of the pair.
 */

import { createLogger } from "../utils/logger";

/**
 * A dispatch refused by the control pair.
 *
 * A distinct type because a denial is **permanent** and every other failure at
 * that point is transient. Callers that retry — the kaambaan bridge hands a
 * claim back and lets the board reissue it — must be able to tell the
 * difference, or a refusal becomes a hot loop: claim, refuse, release, claim
 * again, forever.
 */
export class ControlPairDenied extends Error {
  readonly principalId: string;
  readonly stationKey: string;

  constructor(principalId: string, stationKey: string) {
    super("You do not have permission to dispatch this agent.");
    this.name = "ControlPairDenied";
    this.principalId = principalId;
    this.stationKey = stationKey;
  }
}

/** Is this the control pair refusing, rather than something transient? */
export function isControlPairDenied(e: unknown): e is ControlPairDenied {
  return e instanceof ControlPairDenied || (e as { name?: string })?.name === "ControlPairDenied";
}

const log = createLogger("control-pair");

/** One principal's grant, in the shape the eventual token claim will carry. */
export interface Grant {
  /**
   * Station keys this principal may dispatch work to. Exact, or a single
   * trailing `*` as a prefix wildcard within one segment — `hermes:*` reaches
   * every Hermes station and no OpenClaw one.
   */
  mayDispatch: string[];
  /** Whether this principal may grant an agent its reach. */
  mayGrantReach: boolean;
}

export type Grants = Record<string, Grant>;

/**
 * Parse the configured grants, or throw.
 *
 * Throws rather than falling back, because half-understood authorization
 * configuration is worse than none: it looks enforced and is not. A parse
 * failure belongs in a boot refusal where somebody reads it.
 */
export function parseGrants(raw: string): Grants {
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CONTROL_PAIR_GRANTS must be a JSON object keyed by principal id");
  }

  const grants: Grants = {};
  for (const [principal, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`CONTROL_PAIR_GRANTS["${principal}"] must be an object`);
    }
    const v = value as Record<string, unknown>;

    if (!Array.isArray(v.mayDispatch) || v.mayDispatch.some((s) => typeof s !== "string")) {
      throw new Error(
        `CONTROL_PAIR_GRANTS["${principal}"].mayDispatch must be an array of station-key patterns`
      );
    }
    if (typeof v.mayGrantReach !== "boolean") {
      throw new Error(
        `CONTROL_PAIR_GRANTS["${principal}"].mayGrantReach must be a boolean — both halves of the pair are required`
      );
    }

    grants[principal] = {
      mayDispatch: v.mayDispatch as string[],
      mayGrantReach: v.mayGrantReach,
    };
  }
  return grants;
}

/** Is the control enforced at all? False when nothing is configured. */
export function isControlPairEnforced(raw: string | undefined): boolean {
  return typeof raw === "string" && raw.trim() !== "";
}

/**
 * Read the grants, or null when unenforced.
 *
 * A parse failure returns an EMPTY grant set rather than null, so a broken
 * configuration denies everything instead of disabling the control. Losing the
 * rules must never be the same thing as having none.
 */
function grantsOf(raw: string | undefined): Grants | null {
  if (!isControlPairEnforced(raw)) return null;
  try {
    return parseGrants(raw as string);
  } catch (e) {
    log.error("CONTROL_PAIR_GRANTS could not be parsed — denying all dispatch", {
      error: e instanceof Error ? e.message : String(e),
    });
    return {};
  }
}

/** `hermes:*` matches `hermes:anything`, but never `openclaw:anything`. */
function patternMatches(pattern: string, stationKey: string): boolean {
  if (pattern === stationKey) return true;
  if (!pattern.endsWith("*")) return false;

  const prefix = pattern.slice(0, -1);
  if (!stationKey.startsWith(prefix)) return false;

  // A wildcard may not cross the segment separator it was written inside: a
  // grant of `hermes:*` is about Hermes stations, and reading it as "anything
  // beginning with hermes:" is the same until someone writes `her*`.
  const rest = stationKey.slice(prefix.length);
  return !prefix.includes(":") || !rest.includes(":");
}

/**
 * May this principal dispatch work to this station?
 *
 * True when unenforced. When enforced, a principal with no grant is refused —
 * absence is not permission.
 */
export function mayDispatch(
  raw: string | undefined,
  principalId: string,
  stationKey: string
): boolean {
  const grants = grantsOf(raw);
  if (grants === null) return true; // unenforced

  const grant = grants[principalId];
  if (!grant) return false;

  // An empty list is a decision, and the decision is no. It is also what an
  // operator writes to suspend someone without deleting their grant.
  return grant.mayDispatch.some((p) => patternMatches(p, stationKey));
}

/** May this principal grant an agent its reach? Same two postures. */
export function mayGrantReach(raw: string | undefined, principalId: string): boolean {
  const grants = grantsOf(raw);
  if (grants === null) return true; // unenforced
  return grants[principalId]?.mayGrantReach === true;
}
