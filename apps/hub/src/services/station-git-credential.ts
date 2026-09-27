/**
 * The git credential one station's agent writes with, stored and handed back.
 *
 * Provisioning is an operator act: it creates the agent's forge account if it is missing, mints a
 * token named for the station, and stores that token encrypted. Redemption is a node act, and it
 * is **repeatable** — a git credential helper runs on every fetch and push, so a single-use record
 * would authorise the first `git push` of a turn and refuse the second.
 *
 * What keeps that safe is not scarcity but provenance: this row exists only because an operator
 * provisioned the station, and `routes/station-git-credential.ts` still makes the node prove it
 * hosts the station before it may read it.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { stationGitCredentials } from "../db/schema/git-credentials";
import { decrypt, encrypt } from "../utils/encryption";
import { createLogger } from "../utils/logger";
import {
  ensureAgentUser,
  mintAgentToken,
  revokeAgentToken,
  type FetchLike,
  type ForgeConfig,
} from "./forge";

const log = createLogger("station-git-credential");

export interface ProvisionInput {
  stationId: string;
  tenantId: string;
  /** The forge account this station's agent writes as. One account per agent. */
  username: string;
  /** `owner/repo` entries. Omitted means every repository the account can reach. */
  repositories?: string[];
}

export interface StoredGitCredential {
  stationId: string;
  provider: string;
  username: string;
  tokenName: string;
  repositories: string[] | null;
}

/** The token's name on forge, which is also the handle revocation needs. */
export function tokenNameFor(stationId: string): string {
  return `station-${stationId}`;
}

/**
 * Give a station a git identity, or replace the one it has.
 *
 * Re-provisioning revokes the old token before minting a new one. Leaving it would strand a live
 * credential nobody has a record of — forge will not show a token again after it is created, so a
 * token this row has stopped pointing at can no longer be found by name from our side either.
 */
export async function provisionStationGitCredential(
  cfg: ForgeConfig,
  input: ProvisionInput,
  fetchImpl: FetchLike = fetch,
): Promise<StoredGitCredential> {
  const name = tokenNameFor(input.stationId);

  await ensureAgentUser(cfg, input.username, fetchImpl);

  // Before minting, not after: the name is the only handle, and two tokens cannot share one.
  await revokeAgentToken(cfg, input.username, name, fetchImpl);

  const minted = await mintAgentToken(
    cfg,
    input.username,
    { name, repositories: input.repositories },
    fetchImpl,
  );

  const row = {
    stationId: input.stationId,
    tenantId: input.tenantId,
    provider: "forge",
    username: input.username,
    tokenEncrypted: await encrypt(minted.token),
    tokenName: minted.name,
    repositories: input.repositories ? JSON.stringify(input.repositories) : null,
  };

  await db
    .insert(stationGitCredentials)
    .values(row)
    .onConflictDoUpdate({ target: stationGitCredentials.stationId, set: row });

  log.info("station git credential provisioned", {
    stationId: input.stationId,
    username: input.username,
    repositories: input.repositories?.length ?? 0,
  });

  return {
    stationId: input.stationId,
    provider: "forge",
    username: input.username,
    tokenName: minted.name,
    repositories: input.repositories ?? null,
  };
}

export interface RedeemedGitCredential {
  username: string;
  token: string;
}

/**
 * The credential itself, for a station that has one.
 *
 * Null rather than a throw for "this station has no git identity": it is the ordinary state of
 * every station nobody has provisioned, and the route turns it into its own status.
 */
export async function readStationGitCredential(
  stationId: string,
): Promise<RedeemedGitCredential | null> {
  const [row] = await db
    .select()
    .from(stationGitCredentials)
    .where(eq(stationGitCredentials.stationId, stationId));
  if (!row) return null;

  const token = await decrypt(row.tokenEncrypted);

  // Recorded rather than returned: "when did this station last actually need its credential" is
  // the question an operator asks about a station that looks idle, and nothing else answers it.
  await db
    .update(stationGitCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(stationGitCredentials.stationId, stationId));

  return { username: row.username, token };
}

/**
 * Withdraw a station's credential.
 *
 * Revokes on forge first. A row deleted before the revoke would leave a working token with no
 * record of its name, which is unrevokable in practice.
 */
export async function revokeStationGitCredential(
  cfg: ForgeConfig,
  stationId: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(stationGitCredentials)
    .where(eq(stationGitCredentials.stationId, stationId));
  if (!row) return false;

  await revokeAgentToken(cfg, row.username, row.tokenName, fetchImpl);
  await db
    .delete(stationGitCredentials)
    .where(
      and(
        eq(stationGitCredentials.stationId, stationId),
        eq(stationGitCredentials.tokenName, row.tokenName),
      ),
    );

  log.info("station git credential revoked", { stationId, username: row.username });
  return true;
}
