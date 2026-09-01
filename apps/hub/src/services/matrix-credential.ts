/**
 * Matrix credential authorization — mint and redeem.
 *
 * A human authorises one station to have a Matrix credential. Unlike
 * `enrollment.ts`'s enrollment token, this authorisation carries no token of
 * its own: the party redeeming it (a node) is already authenticated by its
 * own long-term `<nodeId>:<nodeSecret>` and is already required to host the
 * station (`routes/station-matrix-credential.ts`), so there is nothing left
 * for a bearer token to prove. What's minted is a **station-scoped,
 * single-use, time-limited record** — `redeemCredentialAuthorization` asks
 * only "is there a live (unused, unexpired) authorization for this
 * station?", the same question an unauthenticated enrollment token would
 * otherwise have had to answer on its own.
 *
 * `usedAt` is what makes redemption single-use, exactly as it does for
 * `enrollmentTokens` — the UPDATE below sets it in the same statement that
 * checks it is null, so two concurrent redemptions cannot both win.
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/drizzle";
import { matrixCredentialAuthorizations } from "../db/schema/matrix-credentials";
import { stations } from "../db/schema/stations";
import { prefixedId } from "../utils/ids";

/** Default lifetime for a credential authorization: 15 minutes. */
export const CREDENTIAL_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;

/**
 * Thrown by `mintCredentialAuthorization` when `stationId` names no station.
 *
 * A typed error rather than a bare `Error`, so an operator-facing caller can
 * catch this specifically instead of string-matching a message to tell
 * "unknown station" apart from a real failure — the same reasoning
 * `TenantIsolationError` (`db/tenant-scope.ts`) already follows.
 */
export class UnknownStationError extends Error {
  constructor(stationId: string) {
    super(`cannot authorize a Matrix credential for unknown station ${stationId}`);
    this.name = "UnknownStationError";
  }
}

/**
 * Mint an authorization for a station to redeem a Matrix credential.
 *
 * Returns only the expiry — there is no token to hand back. The record
 * itself, keyed by `stationId`, is what `redeemCredentialAuthorization`
 * checks against.
 *
 * **At most one unredeemed authorization per station.** Re-authorising is how
 * an operator retries (Ruling 9: the broker signal is fire-and-forget, so a
 * node that was offline is retried by pressing the button again), and the
 * whole-branch review's Critical made retries routine rather than rare — so an
 * insert-every-time version accumulates live rows for every press. A station's
 * unredeemed row is therefore REFRESHED rather than duplicated: the operator
 * still gets a full window (an expiry that did not move would make the second
 * press useless, which is the opposite of a retry), and the audit trail keeps
 * one row per move rather than one per impatient click.
 *
 * Redeemed rows are never touched. They are the history of moves that actually
 * happened, and a retry after a redemption legitimately needs a new record.
 *
 * Two operators pressing at the exact same instant can still both insert; that
 * is the residual and it is harmless, because `redeemCredentialAuthorization`
 * is scoped by `station_id` alone and consumes every live row for the station
 * in one statement — one credential is issued either way.
 */
export async function mintCredentialAuthorization(
  stationId: string,
  opts?: { ttlMs?: number }
): Promise<{ expiresAt: Date }> {
  const [station] = await db
    .select({ tenantId: stations.tenantId })
    .from(stations)
    .where(eq(stations.id, stationId));
  if (!station) {
    throw new UnknownStationError(stationId);
  }

  const ttlMs = opts?.ttlMs ?? CREDENTIAL_AUTHORIZATION_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  // An unredeemed row is this station's live authorization whether it has
  // expired or not — an expired one is `retired-identity` again, and reviving
  // it is exactly what pressing the button means. Only `usedAt` is final.
  const refreshed = await db
    .update(matrixCredentialAuthorizations)
    .set({ expiresAt })
    .where(
      and(
        eq(matrixCredentialAuthorizations.stationId, stationId),
        isNull(matrixCredentialAuthorizations.usedAt)
      )
    )
    .returning({ id: matrixCredentialAuthorizations.id });
  if (refreshed.length > 0) return { expiresAt };

  await db.insert(matrixCredentialAuthorizations).values({
    id: prefixedId("mcauth"),
    tenantId: station.tenantId,
    stationId,
    expiresAt,
  });

  return { expiresAt };
}

/**
 * Redeem the live authorization for the given station.
 *
 * No token: the caller is a node already authenticated by its own
 * `<nodeId>:<nodeSecret>` and already proven to host this station
 * (`routes/station-matrix-credential.ts`) — redemption is "this
 * authenticated node, for this station, against the live record", and
 * `stationId` is all that is left to identify which record. The UPDATE sets
 * `usedAt` in the same statement that checks it is null and unexpired, so
 * two concurrent redemptions cannot both win. Returns whether a row was
 * updated.
 */
export async function redeemCredentialAuthorization(stationId: string): Promise<boolean> {
  const rows = await db
    .update(matrixCredentialAuthorizations)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(matrixCredentialAuthorizations.stationId, stationId),
        isNull(matrixCredentialAuthorizations.usedAt),
        gt(matrixCredentialAuthorizations.expiresAt, new Date())
      )
    )
    .returning();

  return rows.length > 0;
}
