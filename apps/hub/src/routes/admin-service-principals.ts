/**
 * Service principals, over HTTP — admin-guarded at the mount (`routes/admin.ts`).
 *
 * One call creates the principal, its read-only grant and its first credential, because none of
 * the three is useful alone and a half-made service is a principal nothing can authenticate as —
 * so the three writes are one transaction, and a failure in any leaves none.
 * The secret is in the 201 body and nowhere else: not stored, not logged.
 *
 * Rotation is overlapping: `POST /:principalId/credentials` adds a credential beside the live
 * one, the consumer switches to it, and only then is the old one revoked — so there is never a
 * moment the service holds nothing that works.
 */
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { resolveTenantId } from "../auth/tenant";
import { db } from "../db/drizzle";
import { findOAuthClient, oauthClients, type OAuthClient } from "../config";
import { GRANT_SCOPES, setGrant } from "../services/grants";
import { createPrincipal, listPrincipals, principalById, principalHandle } from "../services/principals";
import { mintServiceCredential, revokeServiceCredential } from "../services/service-credentials";
import { createLogger } from "../utils/logger";

const log = createLogger("admin-service-principals");

const createBody = z.object({
  handle: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  displayName: z.string().min(1).max(120).optional(),
  oauthClient: z.string().min(1),
  scopes: z.array(z.enum(GRANT_SCOPES)).min(1),
});

const credentialBody = z.object({ oauthClient: z.string().min(1) });

const unregistered = (client: string) => ({ error: `no client "${client}" is registered in HUB_OAUTH_CLIENTS` });

export function createAdminServicePrincipalsRouter(deps: { clients?: readonly OAuthClient[] } = {}) {
  const registry = deps.clients ?? oauthClients;
  return new Hono()
    .post("/", zValidator("json", createBody), async (c) => {
      const input = c.req.valid("json");
      if (!findOAuthClient(input.oauthClient, registry)) return c.json(unregistered(input.oauthClient), 400);
      const existing = (await listPrincipals()).find((p) => p.handle === input.handle);
      if (existing) return c.json({ error: "a principal with that handle exists", principalId: existing.id }, 409);

      const tenantId = resolveTenantId(c);
      const { principalId, credential } = await db.transaction(async (tx) => {
        const principalId = await createPrincipal({ kind: "service", handle: input.handle, displayName: input.displayName }, tx);
        // Read-only by construction: may dispatch nobody, may grant nothing.
        await setGrant(principalId, { mayDispatch: [], mayGrantReach: false, scopes: input.scopes }, tx);
        const credential = await mintServiceCredential(
          { tenantId, principalId, oauthClient: input.oauthClient, name: input.handle },
          tx,
        );
        return { principalId, credential };
      });

      log.info("service principal created", {
        principalId, handle: input.handle, scopes: input.scopes, credentialId: credential.id, by: c.get("user")?.id,
      });
      return c.json({ principalId, handle: input.handle, scopes: input.scopes, credential }, 201);
    })
    /**
     * Another credential for an existing service principal — the first half of a rotation. The
     * old credential stays live until it is revoked, so the consumer can switch with no gap.
     */
    .post("/:principalId/credentials", zValidator("json", credentialBody), async (c) => {
      const principalId = c.req.param("principalId");
      const { oauthClient } = c.req.valid("json");
      const principal = await principalById(principalId);
      // A human or an agent authenticates some other way; this route mints for services only.
      if (!principal || principal.kind !== "service") return c.json({ error: "not_found" }, 404);
      if (!findOAuthClient(oauthClient, registry)) return c.json(unregistered(oauthClient), 400);

      const handle = (await principalHandle(principalId)) ?? principalId;
      const credential = await mintServiceCredential({ tenantId: resolveTenantId(c), principalId, oauthClient, name: handle });

      log.info("service credential added", { principalId, credentialId: credential.id, by: c.get("user")?.id });
      return c.json({ credential }, 201);
    })
    .post("/credentials/:id/revoke", async (c) => {
      const id = c.req.param("id");
      if (!(await revokeServiceCredential(resolveTenantId(c), id))) return c.json({ error: "not_found" }, 404);
      log.info("service credential revoked", { credentialId: id, by: c.get("user")?.id });
      return c.body(null, 204);
    });
}
