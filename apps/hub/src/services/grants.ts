/**
 * Reading and writing a principal's grant.
 *
 * This replaces `CONTROL_PAIR_GRANTS` as the source of authority. The env var
 * was the interim the 2026-08-13 decision blessed — static configuration in the
 * shape of the eventual claim — and its whole purpose was that this change would
 * be a data move rather than a redesign. It is.
 *
 * Values are bare principal ids (`prn_…`), matched by equality — per charter
 * decisions/2026-08-30-an-agent-is-a-principal.md §3, which replaced the two
 * namespaced, pattern-matched forms this file used to carry
 * (`agentpod:<node>/<stationKey>`, `kaambaan:<agentId>`) with one enumeration.
 * The phased path — a third value alongside the two retiring ones — was
 * skipped: nothing is in production, so the destination is built directly.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { principalGrants } from "../db/schema/grants";

export interface Grant {
  /** Principal ids. Empty means "may dispatch nothing", which is a decision. */
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
    throw new Error("mayDispatch must be an array of principal ids");
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
 * Does this grant permit dispatching to this principal?
 *
 * Equality, and deliberately nothing more. `charter →
 * decisions/2026-08-30-an-agent-is-a-principal.md` §3 removed patterns because
 * they matched things nobody intended: `hermes:*` silently spanned nodes, and
 * `agentpod:*&#47;hermes` reached a root station that should never have existed.
 *
 * `null` — a station with no agent — is refused, not allowed. An unassigned
 * station is a machine, not an agent.
 *
 * An unrecognised value is ignored rather than denied: a claim is read by more
 * planes over time, and a plane that refused what it did not understand would
 * break each time one was added.
 */
export function grantAllowsPrincipal(grant: Grant | null, principalId: string | null): boolean {
  if (!grant || !principalId) return false;
  return grant.mayDispatch.includes(principalId);
}
