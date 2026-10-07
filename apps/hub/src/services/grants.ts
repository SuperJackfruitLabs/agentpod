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

import { principalDirectory } from "./org-plane/directory";
import { orgPlaneClient } from "./org-plane/client";

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

/**
 * The grant held by `principalId`, or null. It lives at the plane (contract §3.5), read through
 * the directory's 60 s cache.
 */
export async function getGrant(principalId: string): Promise<Grant | null> {
  return (await principalDirectory().principal(principalId))?.grant ?? null;
}

/**
 * Write a grant at the plane. Kept for the one write the hub still makes (decision D3): adding a
 * newly placed agent to the placing human's `mayDispatch` — see `org-plane/agent-placement.ts`.
 */
export async function setGrant(principalId: string, grant: GrantInput): Promise<void> {
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

  // PUT replaces, so scopes this caller did not name are kept from the plane's current grant.
  const current = grant.scopes === undefined ? (await principalDirectory().principal(principalId))?.grant : null;
  await orgPlaneClient().putGrant(principalId, {
    mayDispatch: grant.mayDispatch,
    mayGrantReach: grant.mayGrantReach,
    scopes: grant.scopes !== undefined ? [...new Set(grant.scopes)] : (current?.scopes ?? []),
  });
  principalDirectory().invalidate(principalId);
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
