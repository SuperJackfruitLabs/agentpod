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
 * (`agentpod:<node>/<stationKey>`, `superpipeline:<agentId>`) with one enumeration.
 * The phased path — a third value alongside the two retiring ones — was
 * skipped: nothing is in production, so the destination is built directly.
 */

import { eq } from "drizzle-orm";
import { db, type DbExecutor } from "../db/drizzle";
import { principalGrants } from "../db/schema/grants";

/**
 * Every scope a grant may hold. A writer refuses anything else; a reader ignores it.
 *
 * `evidence:read` — read run evidence: attempts, fingerprints, the dispatch ledger (superwitness
 * contract C5/C6). The hub's evidence routes require it.
 *
 * `runs:write` — report runs to superwitness's run registry (`POST /v1/runs`, superwitness app spec
 * §3.4). Minted into the token's `scope` and honoured by superwitness alone: no hub route reads it,
 * and the evidence routes refuse a principal that holds only this.
 *
 * `transcripts:read` — read what a session SAID: prompts, messages, tool inputs and outputs,
 * redacted (`GET /api/evidence/sessions/:sessionId/transcript…`, superwitness transcripts spec
 * §3.2). Separate from `evidence:read` on purpose, in both directions: knowing that a run failed
 * is not permission to read its content, and reading content is not permission to the ledger.
 */
export const GRANT_SCOPES = ["evidence:read", "runs:write", "transcripts:read"] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];
export const EVIDENCE_READ: GrantScope = "evidence:read";
export const TRANSCRIPTS_READ: GrantScope = "transcripts:read";

export interface Grant {
  /** Principal ids. Empty means "may dispatch nothing", which is a decision. */
  mayDispatch: string[];
  mayGrantReach: boolean;
  /** Permissions beyond the pair. Empty means none. */
  scopes: string[];
}

/**
 * What a writer may send. `scopes` absent means "this caller does not speak scopes" and keeps the
 * stored ones — the same absent-is-not-empty rule the token claims follow — so `fleet grants set`,
 * which predates them, cannot silently strip superwitness's `evidence:read`.
 */
export type GrantInput = { mayDispatch: string[]; mayGrantReach: boolean; scopes?: string[] };

/** A principal with no row has no grant — not an unrestricted one. */
export const NO_GRANT: Grant = { mayDispatch: [], mayGrantReach: false, scopes: [] };

function parseStringArray(raw: string, what: string, principalId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed as string[];
    throw new Error(`grant ${what} for ${principalId} is not an array of strings`);
  } catch (e) {
    throw new Error(
      `refusing to interpret a malformed grant for ${principalId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function getGrant(principalId: string): Promise<Grant | null> {
  const rows = await db
    .select({
      mayDispatch: principalGrants.mayDispatch,
      mayGrantReach: principalGrants.mayGrantReach,
      scopes: principalGrants.scopes,
    })
    .from(principalGrants)
    .where(eq(principalGrants.principalId, principalId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // A corrupt value is neither "everything" (catastrophic) nor "nothing" (silent): it is loud.
  return {
    mayDispatch: parseStringArray(row.mayDispatch, "mayDispatch", principalId),
    mayGrantReach: row.mayGrantReach,
    scopes: parseStringArray(row.scopes, "scopes", principalId),
  };
}

export async function setGrant(principalId: string, grant: GrantInput, exec: DbExecutor = db): Promise<void> {
  if (!Array.isArray(grant.mayDispatch) || grant.mayDispatch.some((v) => typeof v !== "string")) {
    throw new Error("mayDispatch must be an array of principal ids");
  }
  if (typeof grant.mayGrantReach !== "boolean") {
    // Both halves are required. Dispatch control alone is decorative: anyone who
    // can grant an agent its reach does not need permission to dispatch it,
    // because they build the agent they want.
    throw new Error("mayGrantReach must be a boolean — both halves of the pair are required");
  }
  if (grant.scopes !== undefined) {
    const unknown = grant.scopes.filter((s) => !(GRANT_SCOPES as readonly string[]).includes(s));
    if (unknown.length > 0) throw new Error(`unknown scope: ${unknown.join(", ")}`);
  }

  const now = new Date();
  const scopes = grant.scopes !== undefined ? JSON.stringify([...new Set(grant.scopes)]) : undefined;
  await exec
    .insert(principalGrants)
    .values({
      principalId,
      mayDispatch: JSON.stringify(grant.mayDispatch),
      mayGrantReach: grant.mayGrantReach,
      scopes: scopes ?? "[]",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: principalGrants.principalId,
      set: {
        mayDispatch: JSON.stringify(grant.mayDispatch),
        mayGrantReach: grant.mayGrantReach,
        ...(scopes !== undefined ? { scopes } : {}),
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
    scopes: JSON.parse(r.scopes) as string[],
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
