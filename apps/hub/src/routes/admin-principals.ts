/**
 * The directory a grant is written against — and the one place a principal is
 * suspended or restored.
 *
 * A grant names one principal on each side now — the row is keyed by a `prn_`
 * id and every value in `mayDispatch` is one — and nothing else in this API
 * will tell you what those ids are. Without this the console's grants page can
 * only offer a bare text box for a twenty-hex id, which is not a control an
 * organisation can use: an authorization surface nobody can operate is one
 * people route around, which is the same reason `/api/admin/grants` exists at
 * all.
 *
 * Listing is **read-only**, and deliberately. Minting a principal is how an
 * agent comes into existence and is a decision with a handle attached — an
 * immutable address other systems will hold — so it does not belong on a
 * picker's convenience endpoint. This lists what is already there; nothing
 * more.
 *
 * Suspend and restore are the exception, and the reason to put them here
 * rather than leave them as a database script: `buildTokenPayload` already
 * refuses to mint for a suspended principal, on every subject path, but until
 * now that lever had no operator surface — only a function reachable with a
 * database client. `charter` →
 * decisions/2026-08-15-granting-reach-is-changing-an-agent.md is why this is
 * two small, boring, reversible endpoints rather than a new page: a control
 * people route around because it is awkward to use is worse than no control
 * at all.
 *
 * Mounted inside the same admin guard as the rest of `/api/admin`. This is the
 * shape of the fleet's identities: who exists, what kind of thing each one is,
 * which of them is a person, and which of them may currently act. That is not
 * a public list.
 */

import { Hono } from "hono";
import {
  listPrincipals,
  principalById,
  suspendPrincipal,
  restorePrincipal,
} from "../services/principals";

export const adminPrincipalsRouter = new Hono()
  .get("/", async (c) => {
    return c.json({ principals: await listPrincipals() });
  })

  /**
   * Suspend a principal. Idempotent: suspending one that is already
   * suspended succeeds again rather than erroring — an operator
   * double-clicking is ordinary, not a fault.
   *
   * 404 for an id naming nobody, distinctly from that idempotent 200:
   * `suspendPrincipal`'s `UPDATE … WHERE id = …` would otherwise touch zero
   * rows and report success for a principal that was never suspended because
   * it never existed — which is not "double-clicked", it is a typo, and
   * should come back as one.
   */
  .post("/:id/suspend", async (c) => {
    const id = c.req.param("id");
    const existing = await principalById(id);
    if (!existing) return c.json({ error: "no such principal" }, 404);

    await suspendPrincipal(id);
    const updated = await principalById(id);
    return c.json({ id: updated!.id, suspendedAt: updated!.suspendedAt });
  })

  /**
   * Lift a suspension — reversible from the same surface as suspending it,
   * because a control that can only be applied and never undone is one
   * people route around rather than use. Idempotent for the same reason as
   * above: restoring a principal that is not suspended succeeds rather than
   * erroring.
   */
  .post("/:id/restore", async (c) => {
    const id = c.req.param("id");
    const existing = await principalById(id);
    if (!existing) return c.json({ error: "no such principal" }, 404);

    await restorePrincipal(id);
    const updated = await principalById(id);
    return c.json({ id: updated!.id, suspendedAt: updated!.suspendedAt });
  });
