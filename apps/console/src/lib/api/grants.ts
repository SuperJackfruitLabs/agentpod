/**
 * Grants — the control pair, over the admin API.
 *
 * Who may dispatch which agent, and who may grant an agent its reach
 * (`charter` → `decisions/2026-08-13-ecosystem-identity.md`, Decision 4). The
 * hub puts these into every token it issues, and both planes enforce them.
 *
 * This client exists because a control nobody can see is one people route
 * around: until now the only ways to read or change a grant were `curl` and a
 * database client.
 */

import { http } from "./client";

export interface Grant {
  /**
   * The principal ids of the agents this principal may dispatch, matched by
   * equality.
   *
   * One agent, named outright, with no patterns of any kind. The two namespaced
   * pattern forms that used to live here — `agentpod:<node>/<stationKey>` and
   * `kaambaan:<agentId>` — are deleted rather than narrowed (charter
   * decisions/2026-08-30-an-agent-is-a-principal.md §3): they matched things
   * nobody intended, `hermes:*` silently spanned nodes, and an agent is an
   * identity rather than a place a station happens to be.
   */
  mayDispatch: string[];
  mayGrantReach: boolean;
}

/**
 * A principal, as the admin API lists them.
 *
 * The vocabulary a grant is written in. Both sides of a grant are `prn_` ids
 * now, and a twenty-hex id is not something anyone types from memory or
 * recognises on sight — so the page that writes grants has to be able to read
 * this list, or it is a text box and a hope.
 */
export interface PrincipalSummary {
  id: string;
  kind: "human" | "agent" | "service";
  /** Immutable, and what an agent's Matrix address is built from. */
  handle: string;
  displayName: string | null;
  /** The Better Auth login, when this principal is a person. Null otherwise. */
  userId: string | null;
  /**
   * When this principal was suspended, or null if it is not. Carried on the
   * directory itself so the page can show the state without a second call
   * per row — the hub already refuses to mint a token for a suspended
   * principal on every path; this is what tells an operator that lever
   * exists at all.
   */
  suspendedAt: string | null;
}

/** Every principal this hub knows — people, agents and services alike. */
export async function listPrincipals(): Promise<PrincipalSummary[]> {
  const body = await http<{ principals: PrincipalSummary[] }>("/api/admin/principals");
  return body.principals;
}

/**
 * Stop a principal from being allowed to act, from now. Idempotent — this
 * still succeeds for a principal that is already suspended, because an
 * operator double-clicking is ordinary, not an error to surface.
 */
export async function suspendPrincipal(
  principalId: string
): Promise<{ id: string; suspendedAt: string | null }> {
  return http(`/api/admin/principals/${encodeURIComponent(principalId)}/suspend`, {
    method: "POST",
  });
}

/**
 * Lift a suspension — the other half of the same control. Idempotent for the
 * same reason as {@link suspendPrincipal}: restoring one that is not
 * suspended succeeds rather than erroring.
 */
export async function restorePrincipal(
  principalId: string
): Promise<{ id: string; suspendedAt: string | null }> {
  return http(`/api/admin/principals/${encodeURIComponent(principalId)}/restore`, {
    method: "POST",
  });
}

export interface PrincipalGrant extends Grant {
  principalId: string;
}

/**
 * Every grant, and whether anything is enforcing them.
 *
 * `enforced` travels with the data because a page that showed a narrow grant
 * without it would tell an operator the fleet was locked down while
 * `ENFORCE_CONTROL_PAIR` was unset and nothing was checking anything.
 */
export async function listGrants(): Promise<{ grants: PrincipalGrant[]; enforced: boolean }> {
  return http<{ grants: PrincipalGrant[]; enforced: boolean }>("/api/admin/grants");
}

/**
 * One principal's grant.
 *
 * `granted: false` with an empty grant is a real answer, not an error: it means
 * this person has been given nothing, which under enforcement is a refusal.
 */
export async function getGrant(
  principalId: string
): Promise<{ principalId: string; granted: boolean; grant: Grant }> {
  return http(`/api/admin/grants/${encodeURIComponent(principalId)}`);
}

/**
 * Replace a principal's grant.
 *
 * Whole-object, never a merge: an authorization surface must not be easier to
 * widen than to narrow, and a patch that merged arrays would make removing a
 * permission the harder operation.
 */
export async function setGrant(principalId: string, grant: Grant): Promise<void> {
  await http(`/api/admin/grants/${encodeURIComponent(principalId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(grant),
  });
}

/** Remove a grant entirely — distinct from emptying it, though both deny. */
export async function deleteGrant(principalId: string): Promise<void> {
  await http(`/api/admin/grants/${encodeURIComponent(principalId)}`, { method: "DELETE" });
}

/**
 * The one shape a grant value may have: a bare principal id.
 *
 * The same grammar the hub's writer enforces (`PrincipalId` in
 * `@agentpod/contract`, pinned across both repos by
 * `fixtures/ecosystem-identity/id_grammar.json`). Restated here rather than
 * imported so this module stays free of a runtime dependency for one regex —
 * and the server, not this, remains the authority: a value that gets past this
 * is still refused with a 400.
 */
const PRINCIPAL_ID = /^prn_[0-9a-f]{20}$/;

/**
 * Why a value would be rejected, or null when it is fine.
 *
 * Checked here as well as on the server so a typo is answered while the person
 * is still looking at it. The server remains the authority — this only saves a
 * round trip and gives a better sentence than a 400 does.
 *
 * The retired forms are named in the message on purpose. `agentpod:*&#47;hermes:*`
 * was the shape this box asked for until recently, it is still what is written
 * down in older notes, and pasted in today it would be refused with no hint
 * that the whole grammar has been replaced rather than tightened.
 */
export function grantValueProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "empty";

  if (/^(agentpod|kaambaan|org-plane):/.test(trimmed)) {
    return "that form is gone — a grant now names one agent by its principal id (prn_…), with no plane prefix and no patterns";
  }

  if (trimmed.includes("*")) {
    // Worth its own sentence: a wildcard is the value most likely to be typed
    // by someone meaning "all of them", and stored it would match nothing at
    // all — which reads exactly like a working grant.
    return "wildcards match nothing — name each agent by its principal id (prn_…)";
  }

  if (!PRINCIPAL_ID.test(trimmed)) {
    return "must be a principal id — prn_ followed by 20 hex characters";
  }

  return null;
}
