import { Hono } from "hono";
import { mintEnrollmentToken } from "../services/enrollment";
import { requireFleetGrantReach } from "../services/grant-reach";
import { isControlPairEnforced, isGrantReachDenied, GrantReachDenied } from "../services/control-pair";
import { principalForUser } from "../services/principals";

/**
 * POST /api/enrollment-tokens
 * Authenticated route — mints a one-time enrollment token for the current user.
 * Returns { token, expiresAt } where `token` is the plaintext token (shown once).
 *
 * Behind the reach half of the control pair (#345). A machine joining the fleet
 * is an agent being *registered*, which charter Decision 4 names as granting
 * reach: "anyone who can register an agent and grant it production credentials
 * … they build the agent they want."
 *
 * It names no station, so there is no pattern to match against and the rule is
 * the narrower one — you may grow a fleet only if your authority already spans
 * it. Enforced on the route rather than in `mintEnrollmentToken`, because the
 * service is also how the *node* re-enrols itself and how tests build fixtures;
 * this is a check on a person asking, not on a token being made.
 *
 * `requireFleetGrantReach` takes a principal id, not a Better Auth user id, so
 * the caller is resolved to one here via `principalForUser` — the same lookup
 * Task 4's default resolver uses — before the guard runs. Gated behind
 * `isControlPairEnforced()` up front, not just inside the guard: resolving
 * a principal and refusing an unmapped one must stay exactly as inert as the
 * guard itself when the pair is off, or a deployment that never enabled the
 * control pair would start rejecting enrollment for every caller with no
 * principal row — which today is everyone. A caller the pair DOES enforce
 * against and who has no linked principal is refused, the same as a
 * non-admin one: fail closed on an unmapped identity, never fail open.
 */
export const enrollmentTokenRoutes = new Hono().post("/", async (c) => {
  const user = c.get("user");

  try {
    if (isControlPairEnforced()) {
      const principal = await principalForUser(user.id);
      if (!principal) throw new GrantReachDenied(user.id, "fleet", null);
      await requireFleetGrantReach(principal.id);
    }
  } catch (e) {
    if (!isGrantReachDenied(e)) throw e;
    return c.json({ error: "You do not have permission to add machines to this fleet." }, 403);
  }

  const { token, expiresAt } = await mintEnrollmentToken(user.id);
  return c.json({ token, expiresAt: expiresAt.toISOString() });
});
