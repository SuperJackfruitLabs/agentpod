/** The per-grant claim: a bounded process-wide slot and a session advisory lock. */
import { rawSql } from "../../db/drizzle";
import { ForgeApiGrantError } from "./errors";
import { scrub } from "./grant-common";
import { log } from "./grant-log";

/**
 * Connections that must always stay free for the rest of the hub. A claim holds one pooled
 * connection for seconds (provider HTTP + node round trip) and needs a SECOND for every UPDATE it
 * makes, so unbounded claims could take the whole pool and deadlock all DB work.
 */
export const POOL_RESERVE = 3;
const POOL_MAX: number = (rawSql as unknown as { options?: { max?: number } }).options?.max ?? 10;
/** Process-wide bound on concurrent claims: at most 3, and never into the reserve. */
export const CLAIM_CAP = Math.max(1, Math.min(3, POOL_MAX - POOL_RESERVE));
let activeClaims = 0;

/** Test seam: make the unlock fail, to prove a lock-holding connection is never pooled again. */
export const claimFaults = { failUnlock: false };

/**
 * The per-grant claim around mint → persist (→ re-mint) → seal → deliver.
 *
 * 1. A process-wide slot (CLAIM_CAP), taken NON-blocking: none free → `grant-busy` at once.
 *    Queueing would hold request handlers while connections are scarce.
 * 2. A session-level `pg_try_advisory_lock` on a RESERVED connection. It is not a transaction, so
 *    none is held across the provider's HTTP call; a crashed hub drops the connection and the lock.
 *    Not obtained → `grant-busy` (409), and nothing is minted.
 * 3. In `finally`: unlock, release the connection, free the slot. If the unlock fails the
 *    connection may still hold the lock, so it is never handed back to the pool holding it: its
 *    backend is terminated from another connection (postgres.js reconnects), then released.
 */
export async function withGrantClaim<T>(tenantId: string, grantId: string, fn: () => Promise<T>): Promise<T> {
  if (activeClaims >= CLAIM_CAP) {
    throw new ForgeApiGrantError("grant-busy", `forge grants are busy (${CLAIM_CAP} in flight); try again.`, grantId);
  }
  activeClaims++;
  try {
    const conn = await rawSql.reserve();
    const key = `forge-grant|${tenantId}|${grantId}`;
    let pid: number | undefined;
    try {
      const [r] = await conn`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS ok, pg_backend_pid() AS pid`;
      pid = r?.pid as number | undefined;
      if (!r?.ok) {
        throw new ForgeApiGrantError("grant-busy", `forge grant ${grantId} is being worked on by another request; try again.`, grantId);
      }
      try {
        return await fn();
      } finally {
        try {
          if (claimFaults.failUnlock) throw new Error("injected unlock failure");
          await conn`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
        } catch (err) {
          log.warn("forge grant claim unlock failed; discarding the connection", { grantId, error: scrub(err) });
          if (pid !== undefined) await rawSql`SELECT pg_terminate_backend(${pid})`.catch(() => undefined);
        }
      }
    } finally {
      conn.release();
    }
  } finally {
    activeClaims--;
  }
}
