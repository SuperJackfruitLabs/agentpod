/**
 * A plane token's `org` → this hub's tenant (contract §2 "First sight", "Entitlement check").
 * Local only: the hub never calls the plane to create a tenant.
 */
import { and, eq } from "drizzle-orm";
import { db, type DbExecutor } from "../../db/drizzle";
import { tenants } from "../../db/schema/tenants";
import { prefixedId } from "../../utils/ids";

export const AGENTPOD_PRODUCT = "agentpod";
export const ORG_PLANE_SOURCE = "org-plane";

export type TenantResolution =
  | { ok: true; tenantId: string }
  | { ok: false; status: 403; body: { error: "product_not_enabled"; org: string } };

async function find(org: string, exec: DbExecutor): Promise<string | null> {
  const [row] = await exec
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.externalSource, ORG_PLANE_SOURCE), eq(tenants.externalId, org)))
    .limit(1);
  return row?.id ?? null;
}

export async function tenantForOrg(
  claims: { org: string; ent: string[] },
  exec: DbExecutor = db,
): Promise<TenantResolution> {
  // Checked before any read or write, so a refused org never gets a tenant.
  if (!claims.ent.includes(AGENTPOD_PRODUCT)) {
    return { ok: false, status: 403, body: { error: "product_not_enabled", org: claims.org } };
  }
  const existing = await find(claims.org, exec);
  if (existing) return { ok: true, tenantId: existing };

  // First sight. Concurrent first sights race on tenants_external_idx; the losers' inserts are
  // no-ops and every caller reads back the one winner.
  await exec
    .insert(tenants)
    .values({ id: prefixedId("fleet"), name: claims.org, externalSource: ORG_PLANE_SOURCE, externalId: claims.org })
    .onConflictDoNothing({ target: [tenants.externalSource, tenants.externalId] });
  const id = await find(claims.org, exec);
  if (!id) throw new Error(`tenant for ${claims.org} neither found nor created`);
  return { ok: true, tenantId: id };
}
