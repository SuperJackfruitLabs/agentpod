import { Hono } from "hono";
import { mintEnrollmentToken } from "../services/enrollment";
import { requireFleetGrantReach } from "../services/grant-reach";
import { isGrantReachDenied } from "../services/control-pair";

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
 */
export const enrollmentTokenRoutes = new Hono().post("/", async (c) => {
  const user = c.get("user");

  try {
    await requireFleetGrantReach(user.id);
  } catch (e) {
    if (!isGrantReachDenied(e)) throw e;
    return c.json({ error: "You do not have permission to add machines to this fleet." }, 403);
  }

  const { token, expiresAt } = await mintEnrollmentToken(user.id);
  return c.json({ token, expiresAt: expiresAt.toISOString() });
});
