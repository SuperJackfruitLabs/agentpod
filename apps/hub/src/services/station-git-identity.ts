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
import { stations } from "../db/schema/stations";
import { createLogger } from "../utils/logger";
import * as broker from "./broker";
import { connectionManager } from "./connection-manager";
import {
  addAgentKey,
  deleteAgentKey,
  ensureAgentUser,
  readAgentUser,
  type FetchLike,
  type ForgeConfig,
  type ForgeUser,
} from "./forge";
import { principalNames } from "./principals";

const log = createLogger("station-git-identity");

/** The key's title on forge. Names the station so an operator reading the account can tell whose
 * key is whose — an account with four untitled keys is an account nobody will prune. */
export function keyTitleFor(stationId: string): string {
  return `station-${stationId}`;
}

/**
 * Who a station's commits are by. The node puts it in the harness's environment as GIT_AUTHOR_* and
 * GIT_COMMITTER_*, so a commit carries the agent rather than the host's git config.
 */
export interface CommitAuthor {
  name: string;
  email: string;
}

/** What git strips from an ident, or rejects. Removed here so the name sent is the name committed. */
const IDENT_UNSAFE = /[<>\r\n\0]/g;

/**
 * A name for `git log`. A handle-shaped name (`fixture-agent`) becomes words (`Fixture Agent`); one
 * somebody already wrote for people — it has a space or a capital — is left as they wrote it. A
 * station key used as a display name (`harness:fixture-agent`) loses its harness prefix.
 */
export function readableName(raw: string): string {
  const clean = raw.replace(IDENT_UNSAFE, "").replace(/\s+/g, " ").trim();
  if (clean === "" || /\s/.test(clean) || /[A-Z]/.test(clean)) return clean;
  // A station key (`harness:name`) used as a display name: the part after the harness is the agent.
  const local = clean.slice(clean.lastIndexOf(":") + 1);
  return local
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The author a station's commits carry.
 *
 * **Name:** the agent's display name, readable; failing that, forge's full name without the
 * ` (agent)` suffix `ensureAgentUser` gives it; failing that, the login. No suffix in the commit:
 * forge and GitHub link a commit to an account by its email, never its name, and the email's
 * domain already says this is an agent. A suffix would only repeat that in every `git log` line.
 *
 * **Email:** forge's, exactly as forge stores it — never built here. It is what forge matches a
 * commit to the account by, so a hand-built one that drifted from the account would unlink every
 * commit. Without one there is no author: better the host's ident than an unlinkable agent one.
 */
export function commitAuthorFor(input: {
  displayName: string | null | undefined;
  forgeUser: Pick<ForgeUser, "login" | "email" | "full_name">;
}): CommitAuthor | null {
  const email = (input.forgeUser.email ?? "").trim();
  if (email === "" || /[<>\r\n\0\s]/.test(email)) return null;
  const name =
    readableName(input.displayName ?? "") ||
    readableName((input.forgeUser.full_name ?? "").replace(/\s*\(agent\)\s*$/i, "")) ||
    readableName(input.forgeUser.login);
  return name ? { name, email } : null;
}

export interface RegisterInput {
  stationId: string;
  tenantId: string;
  /** Derived by the caller from the station's occupying principal, never supplied by a node. */
  username: string;
  /** OpenSSH public key, as `ssh-keygen` writes it. */
  publicKey: string;
  /** The occupying principal's display name, for the commit author. Null when it has none. */
  displayName?: string | null;
}

export interface StationGitIdentity {
  stationId: string;
  username: string;
  keyId: number;
  rotated: boolean;
  /** Null when forge returned no email for the account. */
  author: CommitAuthor | null;
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
  const { user } = await ensureAgentUser(cfg, input.username, fetchImpl);
  const author = commitAuthorFor({ displayName: input.displayName, forgeUser: user });

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
    authorName: author?.name ?? null,
    authorEmail: author?.email ?? null,
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
    author,
  };
}

/**
 * Tell the node who a station's commits are by. It rides in `git.identity.ensure`, which is
 * idempotent on the node (the same key comes back), so this provisions nothing: a node that
 * predates authors ignores the field, and one that has them records it beside the key.
 *
 * False when the node could not be asked. Not an error: the next reconnect sends it again.
 */
export async function deliverCommitAuthor(
  station: { id: string; nodeId: string; stationKey: string },
  author: CommitAuthor,
  expectedPublicKey?: string,
): Promise<boolean> {
  const res = await broker.request(station.nodeId, "git.identity.ensure", {
    stationId: station.id,
    stationKey: station.stationKey,
    author,
  });
  if (!res.ok) {
    log.warn("commit author not delivered to the node", { stationId: station.id, error: res.error });
    return false;
  }
  const returned = (res.data as { publicKey?: unknown } | undefined)?.publicKey;
  if (expectedPublicKey && typeof returned === "string" && returned.trim() !== expectedPublicKey.trim()) {
    // The node lost its key and made a new one, which forge has never seen: pushes will fail until
    // an operator re-runs grant-push. Said loudly, because nothing else will say it.
    log.warn("node holds a different key than the one registered; re-run grant-push", {
      stationId: station.id,
      nodeId: station.nodeId,
    });
  }
  return true;
}

/**
 * Re-send every identity's author to a node that has just connected.
 *
 * This is the backfill: identities provisioned before authors existed get one the next time their
 * node connects — a node update restarts it — with no key regenerated or re-registered. forge is
 * only READ, and only for a row that has no email yet.
 *
 * The name is refreshed from the principal's display name each time, so renaming an agent reaches
 * its commits at the next reconnect. Only when the station's principal is still the account's
 * owner: a reassigned station must not commit under the new agent's name with the old one's key.
 */
export async function syncStationGitAuthors(
  nodeId: string,
  deps: { forge: ForgeConfig | null; fetchImpl?: FetchLike },
): Promise<void> {
  const rows = await db
    .select({ identity: stationGitIdentities, stationKey: stations.stationKey, principalId: stations.principalId })
    .from(stationGitIdentities)
    .innerJoin(stations, eq(stations.id, stationGitIdentities.stationId))
    .where(eq(stations.nodeId, nodeId));

  for (const { identity, stationKey, principalId } of rows) {
    try {
      const names = principalId ? await principalNames(principalId) : null;
      const displayName = names && names.handle === identity.username ? names.displayName : null;

      let author: CommitAuthor | null = null;
      if (identity.authorName && identity.authorEmail) {
        author = { name: readableName(displayName ?? "") || identity.authorName, email: identity.authorEmail };
      } else if (deps.forge) {
        const user = await readAgentUser(deps.forge, identity.username, deps.fetchImpl ?? fetch);
        author = user ? commitAuthorFor({ displayName, forgeUser: user }) : null;
      }
      if (!author) continue;

      if (author.name !== identity.authorName || author.email !== identity.authorEmail) {
        await db
          .update(stationGitIdentities)
          .set({ authorName: author.name, authorEmail: author.email })
          .where(eq(stationGitIdentities.stationId, identity.stationId));
      }
      await deliverCommitAuthor({ id: identity.stationId, nodeId, stationKey }, author, identity.publicKey);
    } catch (err) {
      log.warn("commit author sync failed for a station", { stationId: identity.stationId, error: String(err) });
    }
  }
}

let syncDeps: { forge: ForgeConfig | null; fetchImpl?: FetchLike } | null = null;
let syncHookInstalled = false;

/**
 * Turn the reconnect sync on (or, with null, off). The hook is installed once; what it uses is
 * whatever was configured last, so a test can point it at its own forge.
 */
export function configureGitAuthorSync(deps: { forge: ForgeConfig | null; fetchImpl?: FetchLike } | null): void {
  syncDeps = deps;
  if (syncHookInstalled) return;
  syncHookInstalled = true;
  connectionManager.onNodeOnline((nodeId) => {
    const current = syncDeps;
    if (!current) return;
    syncStationGitAuthors(nodeId, current).catch((err) => {
      log.warn("commit author sync failed", { nodeId, error: String(err) });
    });
  });
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
