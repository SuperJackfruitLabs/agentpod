/**
 * Minting, verifying and revoking the credential a human exchanges at a terminal.
 *
 * `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`,
 * accepted 2026-09-20, option C: `login` writes a long-lived credential bound to
 * this device, and every command exchanges it for a five-minute token — the same
 * mechanism an agent already uses, with a device credential playing the station
 * credential's role.
 *
 * **Why SHA-256 and not `Bun.password`, which `nodes.secretHash` uses.** The
 * closer analogue is `enrollment_tokens.tokenHash`, not the node secret, and the
 * difference is the preimage. Argon2 exists to make *guessable* secrets expensive
 * to crack offline; the secret here is 32 CSPRNG bytes, so there is nothing to
 * guess and a slow hash buys no security. It would cost something real: every
 * fleet command performs an exchange, and argon2 is deliberately ~100ms, which is
 * a tax on the very ergonomics this change exists to fix.
 *
 * The comparison is still constant-time. Nothing about high entropy excuses
 * leaking, in the timing, how much of a hash matched.
 */

import { and, eq, isNull } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";

import { db } from "../db/drizzle";
import { deviceCredentials } from "../db/schema/devices";
import { prefixedId } from "../utils/ids";

/**
 * 90 days, and it slides — see `exchange`.
 *
 * Long enough that sustained work never meets it, short enough that a laptop in
 * a drawer stops holding a key without anyone remembering to revoke it.
 */
export const DEVICE_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** SHA-256 hex, the same digest `enrollment.ts` uses for its token hashes. */
async function sha256(s: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  ).toString("hex");
}

/** Equal-length hex compare that does not reveal, in the timing, where it differed. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** 32 CSPRNG bytes, base64url — 43 characters, no padding. */
function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface MintedDevice {
  id: string;
  /** Returned ONCE. Never stored, never recoverable, never logged. */
  secret: string;
  name: string;
  expiresAt: Date;
}

/**
 * Create a device credential for a user, and hand back the only copy of its secret.
 *
 * The caller must already have proved who it is — this is called from a route
 * authenticated by a hub token or a session, right after the browser flow that
 * established it.
 */
export async function mintDeviceCredential(input: {
  userId: string;
  tenantId: string;
  name: string;
}): Promise<MintedDevice> {
  const id = prefixedId("dev");
  const secret = randomSecret();
  const expiresAt = new Date(Date.now() + DEVICE_CREDENTIAL_TTL_MS);
  // A blank name would make the inventory unreadable, which is the one thing the
  // accepted record asks this table to be good for.
  const name = input.name.trim() === "" ? "unnamed device" : input.name.trim().slice(0, 120);

  await db.insert(deviceCredentials).values({
    id,
    userId: input.userId,
    tenantId: input.tenantId,
    name,
    secretHash: await sha256(secret),
    expiresAt,
  });

  return { id, secret, name, expiresAt };
}

/** What a successful exchange resolves to. Never includes the hash. */
export interface ExchangedDevice {
  id: string;
  userId: string;
  tenantId: string;
  name: string;
}

/**
 * Verify `<deviceId>:<secret>` and slide its expiry, or answer null.
 *
 * **Null for every failure, undifferentiated**, and the caller must keep it that
 * way: an unknown id, a wrong secret, a revoked device and an expired one are one
 * answer. `station-token.ts` gives the reasoning for the same collapse — telling
 * a 403 from a 404 lets a holder of one id probe for others — and a revoked
 * device is exactly the case where that probing would be most useful to whoever
 * took the laptop.
 *
 * The expiry slide happens here rather than in the route because it is part of
 * what an exchange *is*: a credential that was used is a credential still in use.
 */
export async function exchangeDeviceCredential(
  deviceId: string,
  secret: string,
): Promise<ExchangedDevice | null> {
  if (!deviceId || !secret) return null;

  const [row] = await db
    .select()
    .from(deviceCredentials)
    .where(and(eq(deviceCredentials.id, deviceId), isNull(deviceCredentials.revokedAt)));

  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (!constantTimeEqualHex(await sha256(secret), row.secretHash)) return null;

  const now = new Date();
  await db
    .update(deviceCredentials)
    .set({ lastUsedAt: now, expiresAt: new Date(now.getTime() + DEVICE_CREDENTIAL_TTL_MS) })
    .where(eq(deviceCredentials.id, row.id));

  return { id: row.id, userId: row.userId, tenantId: row.tenantId, name: row.name };
}

/** One user's devices, revoked ones included — a list you can revoke from shows what it revoked. */
export async function listDeviceCredentials(userId: string) {
  return db
    .select({
      id: deviceCredentials.id,
      name: deviceCredentials.name,
      createdAt: deviceCredentials.createdAt,
      lastUsedAt: deviceCredentials.lastUsedAt,
      expiresAt: deviceCredentials.expiresAt,
      revokedAt: deviceCredentials.revokedAt,
    })
    .from(deviceCredentials)
    .where(eq(deviceCredentials.userId, userId));
}

/**
 * Revoke one of this user's devices. True if a live row was revoked.
 *
 * Scoped to `userId` in the WHERE clause rather than checked after the read: a
 * device belonging to somebody else and a device that does not exist must be the
 * same answer, or this endpoint enumerates the table.
 *
 * Idempotent — revoking an already-revoked device answers false and changes
 * nothing, which is the right answer to "is it still live?" either way.
 */
export async function revokeDeviceCredential(userId: string, deviceId: string): Promise<boolean> {
  const revoked = await db
    .update(deviceCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(deviceCredentials.id, deviceId),
        eq(deviceCredentials.userId, userId),
        isNull(deviceCredentials.revokedAt),
      ),
    )
    .returning({ id: deviceCredentials.id });

  return revoked.length > 0;
}
