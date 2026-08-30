/**
 * The directory a grant is written against.
 *
 * A grant names one principal on each side now — the row is keyed by a `prn_`
 * id and every value in `mayDispatch` is one — and nothing else in this API
 * will tell you what those ids are. Without this the console's grants page can
 * only offer a bare text box for a twenty-hex id, which is not a control an
 * organisation can use: an authorization surface nobody can operate is one
 * people route around, which is the same reason `/api/admin/grants` exists at
 * all.
 *
 * **Read-only, and deliberately.** Minting a principal is how an agent comes
 * into existence and is a decision with a handle attached — an immutable
 * address other systems will hold — so it does not belong on a picker's
 * convenience endpoint. This lists what is already there; nothing more.
 *
 * Mounted inside the same admin guard as the rest of `/api/admin`. This is the
 * shape of the fleet's identities: who exists, what kind of thing each one is,
 * and which of them is a person. That is not a public list.
 */

import { Hono } from "hono";
import { listPrincipals } from "../services/principals";

export const adminPrincipalsRouter = new Hono().get("/", async (c) => {
  return c.json({ principals: await listPrincipals() });
});
