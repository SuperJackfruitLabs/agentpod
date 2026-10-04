/**
 * Service principals, over HTTP — admin-guarded at the mount (`routes/admin.ts`).
 *
 * One call creates the principal, its read-only grant and its first credential, because none of
 * the three is useful alone and a half-made service is a principal nothing can authenticate as.
 * The secret is in the 201 body and nowhere else: not stored, not logged.
 */
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { resolveTenantId } from "../auth/tenant";
import { findOAuthClient, oauthClients, type OAuthClient } from "../config";
import { GRANT_SCOPES, setGrant } from "../services/grants";
import { createPrincipal, listPrincipals } from "../services/principals";
import { mintServiceCredential, revokeServiceCredential } from "../services/service-credentials";
import { createLogger } from "../utils/logger";

const log = createLogger("admin-service-principals");

const createBody = z.object({
  handle: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  displayName: z.string().min(1).max(120).optional(),
  oauthClient: z.string().min(1),
  scopes: z.array(z.enum(GRANT_SCOPES)).min(1),
});

export function createAdminServicePrincipalsRouter(deps: { clients?: readonly OAuthClient[] } = {}) {
  const registry = deps.clients ?? oauthClients;
  return new Hono()
    .post("/", zValidator("json", createBody), async (c) => {
      const input = c.req.valid("json");
      if (!findOAuthClient(input.oauthClient, registry)) {
        return c.json({ error: `no client "${input.oauthClient}" is registered in HUB_OAUTH_CLIENTS` }, 400);
      }
      const existing = (await listPrincipals()).find((p) => p.handle === input.handle);
      if (existing) return c.json({ error: "a principal with that handle exists", principalId: existing.id }, 409);

      const principalId = await createPrincipal({ kind: "service", handle: input.handle, displayName: input.displayName });
      // Read-only by construction: may dispatch nobody, may grant nothing.
      await setGrant(principalId, { mayDispatch: [], mayGrantReach: false, scopes: input.scopes });
      const credential = await mintServiceCredential({
        tenantId: resolveTenantId(c),
        principalId,
        oauthClient: input.oauthClient,
        name: input.handle,
      });

      log.info("service principal created", {
        principalId, handle: input.handle, scopes: input.scopes, credentialId: credential.id, by: c.get("user")?.id,
      });
      return c.json({ principalId, handle: input.handle, scopes: input.scopes, credential }, 201);
    })
    .post("/credentials/:id/revoke", async (c) => {
      const id = c.req.param("id");
      if (!(await revokeServiceCredential(id))) return c.json({ error: "not_found" }, 404);
      log.info("service credential revoked", { credentialId: id, by: c.get("user")?.id });
      return c.body(null, 204);
    });
}
