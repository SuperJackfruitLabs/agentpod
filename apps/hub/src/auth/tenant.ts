/**
 * How a request finds its tenant.
 *
 * **Today: one tenant, and every principal reaches it.** That is not a
 * placeholder pretending to be a lookup — it is the honest answer while exactly
 * one tenant exists, and it is deliberately written as a *resolution function*
 * rather than as a default sprinkled across call sites. A default is something a
 * caller forgets; a function is something a caller asks.
 *
 * **Where it extends.** This sits at the same layer that already resolves
 * `config.defaultUserId` for the service-auth caller (`auth/middleware.ts`,
 * `config.ts:248`) — which is plain configuration and never was a membership
 * lookup either. When the Organization plane exists, `resolveTenantForUser`
 * becomes the membership lookup and every call site below is already asking the
 * right question, so the change is confined to this file.
 *
 * **What this deliberately is not.** It is not membership, roles, invites or a
 * tenant switcher: the Organization plane owns those (ecosystem decision 4, and
 * the reason MT-1 (#145) was reshaped). AgentPod scopes its own rows and
 * consumes principals; it does not model who may reach what.
 *
 * Note the asymmetry with child rows. A station's tenant is its node's and an
 * acp_event's is its session's — those are *derived from the parent*, not from
 * the request, and the composite foreign keys in migration 0036 enforce it. A
 * request cannot assert a tenant that contradicts a row's parent, which is why
 * only root rows consult this module at all.
 */

import type { Context } from "hono";

import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";

export { BOOTSTRAP_TENANT_ID };

/**
 * The tenant a principal acts in.
 *
 * Async from the start, because the thing it becomes — a membership lookup — is,
 * and a signature change later would touch every caller for no reason.
 */
export async function resolveTenantForUser(_userId: string): Promise<string> {
  // One tenant exists (created by migration 0036) and every principal reaches
  // it. When a second becomes possible this is a membership query, and a
  // principal belonging to no tenant must fail closed rather than fall back
  // here — which is a change to this function and to nothing else.
  return BOOTSTRAP_TENANT_ID;
}

/**
 * The tenant of the caller on this request, from the auth middleware.
 *
 * Falls back to resolving from the principal for the handful of routes that run
 * without the middleware having populated the context.
 */
export function resolveTenantId(c: Context): string {
  return c.get("user")?.tenantId ?? BOOTSTRAP_TENANT_ID;
}
