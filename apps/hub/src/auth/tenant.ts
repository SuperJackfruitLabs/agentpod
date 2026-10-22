/**
 * How a request finds its tenant.
 *
 * **The tenant always comes from the request** (workspace authority spec, W5). The
 * auth middleware maps the plane token's `org` to a local tenant (`tenantForOrg`,
 * first sight creates `fleet_…`) and puts it on `AuthUser.tenantId`. A root row a
 * request creates (an enrollment token, a runtime, an audit row) takes that tenant;
 * a row acting on another row takes the parent's (a node from its token, a station
 * from its node, an acp_event from its session — the composite foreign keys in
 * migration 0036 enforce those).
 *
 * There used to be a `resolveTenantForUser(userId)` here that answered
 * `BOOTSTRAP_TENANT_ID` for everyone. With a second workspace that sent its
 * enrollments, and so its nodes and stations, into the first workspace's fleet. It
 * is deleted, not repaired: a user id cannot name a tenant — the same person is a
 * member of several workspaces, and which one they act in is the token's `org`.
 *
 * What this deliberately is not: membership, roles or a tenant switcher. The
 * Organization plane owns those.
 */

import type { Context } from "hono";

import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";

export { BOOTSTRAP_TENANT_ID };

/**
 * The tenant of the caller on this request, from the auth middleware.
 *
 * Falls back to the bootstrap tenant only for routes that run without the auth
 * middleware having populated the context (none of the authenticated routes).
 */
export function resolveTenantId(c: Context): string {
  return c.get("user")?.tenantId ?? BOOTSTRAP_TENANT_ID;
}
