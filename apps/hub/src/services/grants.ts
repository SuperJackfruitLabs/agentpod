/**
 * Reading and writing a principal's grant.
 *
 * This replaces `CONTROL_PAIR_GRANTS` as the source of authority. The env var
 * was the interim the 2026-08-13 decision blessed — static configuration in the
 * shape of the eventual claim — and its whole purpose was that this change would
 * be a data move rather than a redesign. It is.
 *
 * Values are namespaced (`agentpod:<stationKey>`, `kaambaan:<agentId>`) per
 * charter decisions/2026-08-15-a-grant-names-an-agent-per-plane.md.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { principalGrants } from "../db/schema/grants";

/** The namespace this plane answers for. Others are ignored, never refused. */
export const AGENTPOD_NS = "agentpod:";

export interface Grant {
  /** Namespaced patterns. Empty means "may dispatch nothing", which is a decision. */
  mayDispatch: string[];
  mayGrantReach: boolean;
}

/** A principal with no row has no grant — not an unrestricted one. */
export const NO_GRANT: Grant = { mayDispatch: [], mayGrantReach: false };

export async function getGrant(principalId: string): Promise<Grant | null> {
  const rows = await db
    .select({
      mayDispatch: principalGrants.mayDispatch,
      mayGrantReach: principalGrants.mayGrantReach,
    })
    .from(principalGrants)
    .where(eq(principalGrants.principalId, principalId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  let mayDispatch: string[];
  try {
    const parsed: unknown = JSON.parse(row.mayDispatch);
    // A stored value that is not an array of strings is a corrupt grant. Reading
    // it as "everything" would be catastrophic and as "nothing" would be silent,
    // so it is neither: the caller gets NO_GRANT and the corruption is loud.
    mayDispatch =
      Array.isArray(parsed) && parsed.every((v) => typeof v === "string")
        ? (parsed as string[])
        : (() => {
            throw new Error(`grant for ${principalId} is not an array of strings`);
          })();
  } catch (e) {
    throw new Error(
      `refusing to interpret a malformed grant for ${principalId}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  return { mayDispatch, mayGrantReach: row.mayGrantReach };
}

export async function setGrant(principalId: string, grant: Grant): Promise<void> {
  if (!Array.isArray(grant.mayDispatch) || grant.mayDispatch.some((v) => typeof v !== "string")) {
    throw new Error("mayDispatch must be an array of namespaced patterns");
  }
  if (typeof grant.mayGrantReach !== "boolean") {
    // Both halves are required. Dispatch control alone is decorative: anyone who
    // can grant an agent its reach does not need permission to dispatch it,
    // because they build the agent they want.
    throw new Error("mayGrantReach must be a boolean — both halves of the pair are required");
  }

  const now = new Date();
  await db
    .insert(principalGrants)
    .values({
      principalId,
      mayDispatch: JSON.stringify(grant.mayDispatch),
      mayGrantReach: grant.mayGrantReach,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: principalGrants.principalId,
      set: {
        mayDispatch: JSON.stringify(grant.mayDispatch),
        mayGrantReach: grant.mayGrantReach,
        updatedAt: now,
      },
    });
}

export async function deleteGrant(principalId: string): Promise<void> {
  await db.delete(principalGrants).where(eq(principalGrants.principalId, principalId));
}

/** Every grant, for the admin surface. */
export async function listGrants(): Promise<Array<{ principalId: string } & Grant>> {
  const rows = await db.select().from(principalGrants);
  return rows.map((r) => ({
    principalId: r.principalId,
    mayDispatch: JSON.parse(r.mayDispatch) as string[],
    mayGrantReach: r.mayGrantReach,
  }));
}

/**
 * What a grant value has to identify, and why a station key alone will not do.
 *
 * Station keys are **not unique across the fleet**: uniqueness is
 * `(node_id, station_key)`, and in production `opencode:c52ddf65` exists on two
 * different nodes today. Matching on the key alone would mean a grant for an
 * agent on a staging box silently authorising the identically-named agent in
 * production — different host, different workspace, different credentials.
 *
 * So a value names a node and a station:
 *
 *     agentpod:<nodePattern>/<stationKeyPattern>
 *
 *     agentpod:*&#47;hermes:*                 every Hermes station, anywhere
 *     agentpod:molt-bot/hermes:*          every Hermes station on molt-bot
 *     agentpod:molt-bot/hermes:analyst-echo   exactly one
 *
 * `/` separates them because station keys already contain `:`.
 *
 * Node NAMES rather than ids, because a grant has to be readable by the person
 * who writes it, and ids are opaque and change when a runtime is reprovisioned.
 *
 * That only works because names are now unique within a tenant, by construction:
 * enrollment suffixes a collision (`molt-bot`, `molt-bot-2`) and migration 0043
 * enforces it. Before that they were merely usually distinct — which is the same
 * assumed-uniqueness that made station keys unsafe to grant on in the first
 * place.
 */
export interface StationRef {
  /** The node's display name — unique within the tenant. */
  nodeName: string;
  stationKey: string;
}

/** `hermes:*` matches `hermes:x`, but never crosses the `:` it was written inside. */
function segmentMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;
  if (!pattern.endsWith("*")) return false;

  const prefix = pattern.slice(0, -1);
  if (!value.startsWith(prefix)) return false;
  const rest = value.slice(prefix.length);
  return !prefix.includes(":") || !rest.includes(":");
}

/**
 * Does one namespaced value permit dispatching this station?
 *
 * Only `agentpod:` values are considered; anything else belongs to another plane
 * and is ignored rather than denied.
 *
 * A value without a `/` is the earlier two-part form (`agentpod:hermes:*`). It
 * matches NOTHING — deliberately, because it cannot say which node it meant, and
 * silently reading it as "any node" is exactly the over-grant this shape exists
 * to remove.
 */
export function patternMatchesStation(pattern: string, station: StationRef): boolean {
  if (!pattern.startsWith(AGENTPOD_NS)) return false; // another plane's business

  const target = pattern.slice(AGENTPOD_NS.length);
  const slash = target.indexOf("/");
  if (slash === -1) return false; // the retired two-part form names no node

  const nodePattern = target.slice(0, slash);
  const keyPattern = target.slice(slash + 1);
  if (!nodePattern || !keyPattern) return false;

  return segmentMatches(nodePattern, station.nodeName) && segmentMatches(keyPattern, station.stationKey);
}

/** May this principal dispatch this station, given their grant? */
export function grantAllowsStation(grant: Grant | null, station: StationRef): boolean {
  if (!grant) return false; // no grant is not an unrestricted grant
  return grant.mayDispatch.some((p) => patternMatchesStation(p, station));
}
