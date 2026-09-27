/**
 * Registering the key a station pushes with.
 *
 * The node generates the keypair and keeps the private half. This registers the public half on the
 * agent's forge account and records the id forge gives it back, which is the only handle
 * revocation has — forge cannot be asked to find a key by its content.
 *
 * Nothing here holds a secret. A credential the hub never sees is one a hub compromise cannot
 * leak, which is why this replaced an earlier design that stored an encrypted token.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { stationGitIdentities } from "../db/schema/git-identities";
import { createLogger } from "../utils/logger";
import { addAgentKey, deleteAgentKey, ensureAgentUser, type FetchLike, type ForgeConfig } from "./forge";

const log = createLogger("station-git-identity");

/** The key's title on forge. Names the station so an operator reading the account can tell whose
 * key is whose — an account with four untitled keys is an account nobody will prune. */
export function keyTitleFor(stationId: string): string {
  return `station-${stationId}`;
}

export interface RegisterInput {
  stationId: string;
  tenantId: string;
  /** Derived by the caller from the station's occupying principal, never supplied by a node. */
  username: string;
  /** OpenSSH public key, as `ssh-keygen` writes it. */
  publicKey: string;
}

export interface StationGitIdentity {
  stationId: string;
  username: string;
  keyId: number;
  rotated: boolean;
}

/**
 * Give a station a key, or replace the one it has.
 *
 * The old key is deleted **before** the new one is registered. Leaving it would let a station push
 * with a key the row no longer names, which is a credential nobody can find to revoke — the same
 * reasoning the token design used, and the reason `key_id` is stored at all.
 */
export async function registerStationGitIdentity(
  cfg: ForgeConfig,
  input: RegisterInput,
  fetchImpl: FetchLike = fetch,
): Promise<StationGitIdentity> {
  await ensureAgentUser(cfg, input.username, fetchImpl);

  const [existing] = await db
    .select()
    .from(stationGitIdentities)
    .where(eq(stationGitIdentities.stationId, input.stationId));

  if (existing) {
    await deleteAgentKey(cfg, existing.username, existing.keyId, fetchImpl);
  }

  const registered = await addAgentKey(
    cfg,
    input.username,
    keyTitleFor(input.stationId),
    input.publicKey,
    fetchImpl,
  );

  const row = {
    stationId: input.stationId,
    tenantId: input.tenantId,
    provider: "forge",
    username: input.username,
    keyId: registered.id,
    publicKey: input.publicKey.trim(),
    ...(existing ? { rotatedAt: new Date() } : {}),
  };

  await db
    .insert(stationGitIdentities)
    .values(row)
    .onConflictDoUpdate({ target: stationGitIdentities.stationId, set: row });

  log.info("station git identity registered", {
    stationId: input.stationId,
    username: input.username,
    keyId: registered.id,
    rotated: Boolean(existing),
  });

  return {
    stationId: input.stationId,
    username: input.username,
    keyId: registered.id,
    rotated: Boolean(existing),
  };
}

/** Withdraw a station's key. False when it had none, which is not an error. */
export async function revokeStationGitIdentity(
  cfg: ForgeConfig,
  stationId: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(stationGitIdentities)
    .where(eq(stationGitIdentities.stationId, stationId));
  if (!row) return false;

  // forge first: a row deleted before the key would leave a working key with no record of its id,
  // and forge cannot be asked to find it by content.
  await deleteAgentKey(cfg, row.username, row.keyId, fetchImpl);
  await db.delete(stationGitIdentities).where(eq(stationGitIdentities.stationId, stationId));

  log.info("station git identity revoked", { stationId, username: row.username, keyId: row.keyId });
  return true;
}
