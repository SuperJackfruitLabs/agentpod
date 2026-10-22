import { Hono } from "hono";
import { mintEnrollmentToken } from "../services/enrollment";
import { requireFleetGrantReach } from "../services/grant-reach";
import { isControlPairEnforced, isGrantReachDenied, GrantReachDenied } from "../services/control-pair";
import { callerPrincipal } from "../auth/caller-authority";
import { requireWorkspaceAdmin } from "../auth/workspace-authority";
import { createLogger } from "../utils/logger";

const log = createLogger("enrollment-tokens");

/**
 * POST /api/enrollment-tokens
 * Authenticated route — mints a one-time enrollment token for the current user,
 * in the tenant of the workspace the request acts in (`user.tenantId`, from the
 * token's `org`), so the node it enrols joins that workspace's fleet (W5).
 * Returns { token, expiresAt } where `token` is the plaintext token (shown once).
 *
 * Behind the reach half of the control pair (#345). A machine joining the fleet
 * is an agent being *registered*, which charter Decision 4 names as granting
 * reach: "anyone who can register an agent and grant it production credentials
 * … they build the agent they want."
 *
 * It names no station, so there is nothing for a grant to be compared against.
 * The rule used to be "you may grow a fleet only if your authority already
 * spans it" — a dispatch value whose node half was `*`. With wildcards deleted
 * (charter decisions/2026-08-30-an-agent-is-a-principal.md §3) there is no way
 * to write "spans", and 2026-08-15-granting-reach-is-changing-an-agent
 * explicitly rejected a second scoped list as the asymmetric-grant hazard
 * restated. So `requireFleetGrantReach` asks whether the caller is an admin
 * of the workspace (workspace authority spec), the same gate this route now
 * applies unconditionally ahead of it. Enforced on the route rather than in
 * `mintEnrollmentToken`, because the service is also how the *node* re-enrols
 * itself and how tests build fixtures; this is a check on a person asking, not
 * on a token being made.
 *
 * The caller is resolved to a principal here via `callerPrincipal` (the
 * token's own `sub` under the org plane, design §5.7) before the guard runs,
 * so an unmapped caller is refused. Gated behind
 * `isControlPairEnforced()` up front, not just inside the guard: resolving
 * a principal and refusing an unmapped one must stay exactly as inert as the
 * guard itself when the pair is off, or a deployment that never enabled the
 * control pair would start rejecting enrollment for every caller with no
 * principal row — which today is everyone. A caller the pair DOES enforce
 * against and who has no linked principal is refused, the same as a
 * non-admin one: fail closed on an unmapped identity, never fail open.
 */
export const enrollmentTokenRoutes = new Hono().post("/", async (c) => {
  // Enrolling a machine is a workspace admin's act, always (workspace authority spec, gate map);
  // the control pair, when enforced, still applies on top of it.
  const refused = requireWorkspaceAdmin(c);
  if (refused) return refused;
  const user = c.get("user");

  try {
    if (isControlPairEnforced()) {
      const principal = await callerPrincipal(user);
      if (!principal) {
        log.warn("fleet-level reach refused: no principal for this caller", { principalId: user.id });
        throw new GrantReachDenied(user.id, "fleet", null);
      }
      await requireFleetGrantReach(user);
    }
  } catch (e) {
    if (!isGrantReachDenied(e)) throw e;
    return c.json({ error: "You do not have permission to add machines to this fleet." }, 403);
  }

  const { token, expiresAt } = await mintEnrollmentToken(user.id, user.tenantId);
  return c.json({ token, expiresAt: expiresAt.toISOString() });
});
