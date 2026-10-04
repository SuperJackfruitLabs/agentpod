import { and, eq, isNull } from "drizzle-orm";
import { ServiceCredentialId } from "@agentpod/contract";

import { db, type DbExecutor } from "../db/drizzle";
import { tenantScope } from "../db/tenant-scope";
import { serviceCredentials } from "../db/schema/service-credentials";
import { prefixedId } from "../utils/ids";
import { constantTimeEqualHex, randomSecret, sha256 } from "./device-credentials";

export interface MintedServiceCredential {
  id: string;
  /** Returned ONCE. Never stored, never logged. */
  secret: string;
  oauthClient: string;
}

export async function mintServiceCredential(input: {
  tenantId: string;
  principalId: string;
  oauthClient: string;
  name: string;
}, exec: DbExecutor = db): Promise<MintedServiceCredential> {
  const id = prefixedId("svc");
  const secret = randomSecret();
  await exec.insert(serviceCredentials).values({
    id,
    tenantId: input.tenantId,
    principalId: input.principalId,
    oauthClient: input.oauthClient,
    name: input.name.trim() === "" ? "unnamed service" : input.name.trim().slice(0, 120),
    secretHash: await sha256(secret),
  });
  return { id, secret, oauthClient: input.oauthClient };
}

/** Null for every failure — malformed, unknown, revoked, wrong secret — so none can be told apart. */
export async function exchangeServiceCredential(
  id: string,
  secret: string,
): Promise<{ id: string; principalId: string; oauthClient: string; tenantId: string } | null> {
  if (!ServiceCredentialId.safeParse(id).success || !secret) return null;
  const [row] = await db
    .select()
    .from(serviceCredentials)
    .where(and(eq(serviceCredentials.id, id), isNull(serviceCredentials.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (!constantTimeEqualHex(await sha256(secret), row.secretHash)) return null;
  await db.update(serviceCredentials).set({ lastUsedAt: new Date() }).where(eq(serviceCredentials.id, row.id));
  return { id: row.id, principalId: row.principalId, oauthClient: row.oauthClient, tenantId: row.tenantId };
}

/** False when no live credential with this id exists IN THIS TENANT — another tenant's is not found. */
export async function revokeServiceCredential(tenantId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(serviceCredentials)
    .set({ revokedAt: new Date() })
    .where(tenantScope(serviceCredentials, tenantId, eq(serviceCredentials.id, id), isNull(serviceCredentials.revokedAt)))
    .returning({ id: serviceCredentials.id });
  return rows.length > 0;
}
