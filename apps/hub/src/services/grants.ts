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
 * Does a namespaced pattern match a station key?
 *
 * Only `agentpod:` patterns are considered. Anything else belongs to another
 * plane and is **ignored rather than denied** — refusing what we do not
 * understand would break this check the day a third plane appears, and a claim
 * is read by more planes over time, not fewer.
 */
export function patternMatchesStation(pattern: string, stationKey: string): boolean {
  if (!pattern.startsWith(AGENTPOD_NS)) return false; // another plane's business
  const target = pattern.slice(AGENTPOD_NS.length);

  if (target === stationKey) return true;
  if (!target.endsWith("*")) return false;

  const prefix = target.slice(0, -1);
  if (!stationKey.startsWith(prefix)) return false;

  // A wildcard may not cross the separator it was written inside: `hermes:*` is
  // about Hermes stations, and reading it as "anything starting with hermes:"
  // stays the same until somebody writes `her*`.
  const rest = stationKey.slice(prefix.length);
  return !prefix.includes(":") || !rest.includes(":");
}

/** May this principal dispatch this station, given their grant? */
export function grantAllowsStation(grant: Grant | null, stationKey: string): boolean {
  if (!grant) return false; // no grant is not an unrestricted grant
  return grant.mayDispatch.some((p) => patternMatchesStation(p, stationKey));
}
