/**
 * Whom a decision escalates to: the workspace's owners and admins, as Accounts knows them, who have
 * linked a Matrix identity (charter: "Unanswered decisions remind, then escalate" §3).
 *
 * Read through the organization plane's directory the hub already uses (`list("human")` with each
 * person's `role` and `organizationId`, contract §3.5, and their Matrix identity) — no new
 * credential. A Matrix id is never guessed, so an admin who never linked one is not invited.
 */
import { eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { tenants } from "../../db/schema/tenants";
import { principalDirectory } from "../../auth/org-plane/directory";
import { matrixIdForPrincipal } from "../matrix";
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-workspace-admins");

/**
 * The Matrix ids of a tenant's workspace owners and admins. Empty for a tenant that is no
 * organization's (a hub's bootstrap tenant). Throws when the plane cannot be read with nothing
 * cached: "could not ask" is not "nobody to tell", and the push is retried.
 */
export async function workspaceAdminMatrixIds(tenantId: string): Promise<string[]> {
  const [tenant] = await db
    .select({ source: tenants.externalSource, org: tenants.externalId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const org = tenant?.source === "org-plane" ? tenant.org : null;
  if (!org) {
    log.warn("a decision escalated in a workspace with no organization; nobody to invite", { tenantId });
    return [];
  }
  const admins = (await principalDirectory().list("human")).filter(
    (p) => p.organizationId === org && !p.suspended && (p.role === "owner" || p.role === "admin"),
  );
  const mxids: string[] = [];
  for (const admin of admins) {
    const mxid = await matrixIdForPrincipal(admin.id);
    if (mxid) mxids.push(mxid);
  }
  return [...new Set(mxids)];
}
