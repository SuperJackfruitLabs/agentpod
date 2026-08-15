/**
 * Grants, over HTTP.
 *
 * Without this the control pair is operable only by someone with a database
 * client, which is not a control an organisation can actually use — and an
 * authorization system nobody can inspect is one people route around.
 *
 * Admin-guarded, like everything else under `/api/admin`. Deliberately: the
 * second half of the pair is *who may grant an agent its reach*, and an endpoint
 * that let any principal edit grants would be the exact hole that half exists to
 * close. Until `mayGrantReach` is itself enforced somewhere, admin is the
 * stand-in, and it is a narrower one.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createLogger } from "../utils/logger";
import { getGrant, setGrant, deleteGrant, listGrants, NO_GRANT } from "../services/grants";

const log = createLogger("admin-grants");

/**
 * The planes a grant may name.
 *
 * An explicit list, not a shape. The obvious implementation — "anything before a
 * colon is a namespace" — accepts `hermes:*`, which is precisely the retired
 * `CONTROL_PAIR_GRANTS` format this is meant to stop: `hermes` looks exactly
 * like a plane name. It would store happily, match nothing anywhere, and read as
 * a working grant, which is the worst of the three outcomes.
 *
 * `org-plane` is here before it exists, for the same reason it is in the
 * identity systems: adopting it should be a data move.
 *
 * Note the asymmetry with the reader, and that it is deliberate. A READER
 * ignores a namespace it does not recognise, because a claim is read by more
 * planes over time. A WRITER refuses one, because this is where a human types a
 * value and a typo should come back as an error rather than as silence.
 */
const KNOWN_PLANES = ["agentpod", "kaambaan", "org-plane"] as const;

const grantValue = z
  .string()
  .min(3)
  .refine(
    (v) => KNOWN_PLANES.some((p) => v.startsWith(`${p}:`) && v.length > p.length + 1),
    `a grant value must name a known plane: ${KNOWN_PLANES.map((p) => `${p}:…`).join(", ")}`
  );

const grantBody = z.object({
  mayDispatch: z.array(grantValue),
  mayGrantReach: z.boolean(),
});

export const adminGrantsRouter = new Hono()
  /** Every grant. The answer to "who may dispatch what", which nothing else answers. */
  .get("/", async (c) => {
    return c.json({ grants: await listGrants() });
  })

  /**
   * One principal's grant.
   *
   * A principal with no row returns `granted: false` and an empty grant rather
   * than 404: "this person has no permissions" is a real, useful answer, and a
   * 404 would make a console show an error where it should show a blank slate.
   */
  .get("/:principalId", async (c) => {
    const principalId = c.req.param("principalId");
    const grant = await getGrant(principalId);
    return c.json({ principalId, granted: grant !== null, grant: grant ?? NO_GRANT });
  })

  /** Set a principal's grant. Whole-object, not a patch — see below. */
  .put("/:principalId", zValidator("json", grantBody), async (c) => {
    const principalId = c.req.param("principalId");
    const body = c.req.valid("json");

    // Whole-object on purpose. A PATCH that merged arrays would make removing a
    // permission harder than adding one, and an authorization surface should
    // never be easier to widen than to narrow.
    await setGrant(principalId, body);

    log.info("grant updated", {
      principalId,
      mayDispatch: body.mayDispatch,
      mayGrantReach: body.mayGrantReach,
      by: c.get("user")?.id,
    });

    return c.json({ principalId, grant: body });
  })

  /**
   * Remove a principal's grant entirely.
   *
   * Not the same as setting an empty one, and both are useful: an empty grant
   * says "considered, and permitted nothing", while no grant says "never
   * considered". Under enforcement they behave identically — which is the point
   * — but they read differently to whoever comes next.
   */
  .delete("/:principalId", async (c) => {
    const principalId = c.req.param("principalId");
    await deleteGrant(principalId);
    log.info("grant removed", { principalId, by: c.get("user")?.id });
    return c.body(null, 204);
  });
