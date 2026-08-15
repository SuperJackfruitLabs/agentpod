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
   * Namespaced patterns. AgentPod's name a node AND a station —
   * `agentpod:<nodeName>/<stationKey>` — because station keys repeat across
   * nodes. `kaambaan:<agentId>` is matched by the board.
   */
  mayDispatch: string[];
  mayGrantReach: boolean;
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

/** The planes a value may name. Mirrors the writer's allowlist on the hub. */
export const KNOWN_PLANES = ["agentpod", "kaambaan", "org-plane"] as const;

/**
 * Why a value would be rejected, or null when it is fine.
 *
 * Checked here as well as on the server so a typo is answered while the person
 * is still looking at it. The server remains the authority — this only saves a
 * round trip and gives a better sentence than a 400 does.
 */
export function grantValueProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "empty";

  const plane = KNOWN_PLANES.find((p) => trimmed.startsWith(`${p}:`));
  if (!plane) {
    return `must name a plane: ${KNOWN_PLANES.map((p) => `${p}:…`).join(", ")}`;
  }
  const rest = trimmed.slice(plane.length + 1);
  if (rest === "") return "names a plane but nothing in it";

  if (plane === "agentpod" && !rest.includes("/")) {
    // The trap worth catching early: `agentpod:hermes:*` looks right and matches
    // nothing, because station keys repeat across nodes and it cannot say which
    // node it meant.
    return "must name a node too — agentpod:<node>/<stationKey>, e.g. agentpod:*/hermes:*";
  }

  return null;
}
