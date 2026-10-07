/**
 * `GET /api/admin/principals` — who exists in this hub's workspace, read through the org plane
 * (decision D3). The console's agents page and its fleet store need it to put handles against
 * `prn_` ids.
 *
 * Read-only. Creating principals, granting them and suspending them is done by a person at the
 * plane's pages (contract §3.5); `POST /:id/suspend` and `/:id/restore` answer 410
 * `managed_by_org_plane` from `auth/org-plane/retired.ts`.
 *
 * Mounted inside the admin guard: the shape of the fleet's identities is not a public list.
 */

import { Hono } from "hono";
import { listPrincipals } from "../services/principals";

export const adminPrincipalsRouter = new Hono().get("/", async (c) => {
  return c.json({ principals: await listPrincipals() });
});
