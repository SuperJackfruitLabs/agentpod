/**
 * Matrix credential authorization — mint and redeem.
 *
 * A human authorises one station to have a Matrix credential; the node then
 * redeems that authorisation for the credential itself. This is the same
 * shape as `enrollment.ts`'s enrollment token, deliberately: a hashed token,
 * an `expiresAt`, and a `usedAt` that makes redemption single-use.
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/drizzle";
import { matrixCredentialAuthorizations } from "../db/schema/matrix-credentials";
import { stations } from "../db/schema/stations";
import { prefixedId } from "../utils/ids";

/** SHA-256 hex digest of a string. Same helper `enrollment.ts` hashes tokens with. */
const sha256 = async (s: string): Promise<string> =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  ).toString("hex");

/** Default lifetime for a credential authorization: 15 minutes. */
export const CREDENTIAL_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;

/**
 * Mint an authorization for a station to redeem a Matrix credential.
 * The raw token is returned once; only its SHA-256 hash is persisted.
 */
export async function mintCredentialAuthorization(
  stationId: string,
  opts?: { ttlMs?: number }
): Promise<{ token: string; expiresAt: Date }> {
  const [station] = await db
    .select({ tenantId: stations.tenantId })
    .from(stations)
    .where(eq(stations.id, stationId));
  if (!station) {
    throw new Error(`cannot authorize a Matrix credential for unknown station ${stationId}`);
  }

  const ttlMs = opts?.ttlMs ?? CREDENTIAL_AUTHORIZATION_TTL_MS;
  const token = prefixedId("mca") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + ttlMs);

  await db.insert(matrixCredentialAuthorizations).values({
    id: prefixedId("mcauth"),
    tenantId: station.tenantId,
    stationId,
    tokenHash: await sha256(token),
    expiresAt,
  });

  return { token, expiresAt };
}

/**
 * Redeem an authorization for the given station.
 *
 * The UPDATE sets `usedAt` in the same statement that checks the row is for
 * this station, unused and unexpired — so two concurrent redemptions of the
 * same token cannot both win. Returns whether one row was updated.
 */
export async function redeemCredentialAuthorization(
  stationId: string,
  token: string
): Promise<boolean> {
  const hash = await sha256(token);

  const rows = await db
    .update(matrixCredentialAuthorizations)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(matrixCredentialAuthorizations.stationId, stationId),
        eq(matrixCredentialAuthorizations.tokenHash, hash),
        isNull(matrixCredentialAuthorizations.usedAt),
        gt(matrixCredentialAuthorizations.expiresAt, new Date())
      )
    )
    .returning();

  return rows.length > 0;
}
