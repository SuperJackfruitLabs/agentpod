/**
 * Forge API access lifecycle, minted mode: grant → mint → seal → deliver
 * (spec docs/superpowers/specs/2026-10-17-forge-api-access-design.md, "Lifecycle and failure handling").
 *
 * The rules this file exists to keep:
 *
 * - **The token lives in one local variable**, in `mintAndDeliver`, between `provider.mint` and
 *   `deps.seal`. It is never logged, stored, audited, put in a frame or in an error. Reasons and
 *   error messages are built from fixed text and ids; a provider/sealer/node error message is
 *   passed through `scrub` (which removes the token if it is known) before it is kept anywhere.
 * - **The station's public key is fetched before anything is minted**, so an unreachable station
 *   or an old node never leaves an orphan token at the provider.
 * - **The token handle is persisted (state `provisioned`) before sealing or delivery**, so a crash
 *   or a failed delivery leaves something reconcile can retry or revoke. A retry with a live sealed
 *   blob re-sends that blob; one without (expired after 24 h, or never stored) cannot re-seal — the
 *   hub has no plaintext — so it revokes the old token and mints generation + 1.
 * - **Every frame is validated with the contract schema before `broker.request`** (which does not
 *   validate), and **`delivered` needs a positive acknowledgement** (`ok === true && stored ===
 *   true`, parsed with the contract result schema). Silence, an empty reply or an unknown verb is
 *   never success.
 * - **Every state change is one UPDATE through `transition`**, which enforces the state graph and
 *   writes the fields the table's CHECKs pair (state/revoked_at, sealed_blob/sealed_expires_at).
 *
 * Every query is tenant-scoped. After delivery (verify, rotate, revoke, policy, and the supplied
 * and app modes) see the second half of this file; its rules are written there.
 */
import {
  ForgeApiPreset as ForgeApiPresetSchema,
  ForgeApiRule as ForgeApiRuleSchema,
  STK_HANDOVER_PREFIX,
  VERB_PARAMS,
  VERB_RESULTS,
  type ForgeApiMode,
  type ForgeApiPreset,
  type ForgeApiProvider,
  type ForgeApiRule,
} from "@agentpod/contract";
import { and, eq, inArray, ne } from "drizzle-orm";

import { rawSql, type Database, type DbExecutor } from "../db/drizzle";
import {
  stationForgeApiGrants as g,
  type ForgeGrantState,
  type ForgeTokenHandle,
  type ForgeTokenRef,
  type StationForgeApiGrant,
} from "../db/schema/forge-api-grants";
import { stations } from "../db/schema/stations";
import { createLogger } from "../utils/logger";
import { recordAudit } from "./audit";
import { ForgeApiGrantError } from "./forge-api/errors";
import { nextGeneration } from "./forge-api/generation";
import { tokenName } from "./forge-api/forgejo";
import { splitRepo, type ForgeGrantRef, type ForgeProvider } from "./forge-api/providers";
import { principalHandle } from "./principals";

export { ForgeApiGrantError } from "./forge-api/errors";

const log = createLogger("station-forge-api");

/** A sealed blob not acknowledged within this window is discarded (spec: sealed-blob expiry). */
export const SEALED_BLOB_TTL_MS = 24 * 60 * 60 * 1000;

type BrokerReply = { ok: boolean; data?: unknown; error?: string };

export interface ForgeApiDeps {
  db: Database;
  broker: { request(nodeId: string, verb: string, params: unknown): Promise<BrokerReply> };
  providers: (kind: ForgeApiProvider) => ForgeProvider;
  now: () => Date;
  /** Seal material to a station's stk handover public key (`sealHandover` in production). */
  seal: (publicKey: string, material: Record<string, string>) => Promise<string>;
  /**
   * The station's stk handover public key. Defaults to asking the node (`forge.api.status`), see
   * `fetchStationPublicKey`. Injectable so a caller with a cached key can skip the round trip.
   */
  stationPublicKey?: (station: { id: string; nodeId: string }) => Promise<string>;
}

export interface CreateForgeApiGrantInput {
  tenantId: string;
  stationId: string;
  /** The user acting (audit + created_by). Authorisation is the route's job. */
  actor: string;
  provider: ForgeApiProvider;
  instance: string;
  mode: ForgeApiMode;
  repositories: string[];
  preset: ForgeApiPreset;
  rules: ForgeApiRule[];
  allowGraphql: boolean;
  /**
   * minted: IGNORED — the expected login is the account, and the account is the station's
   * occupant, never something a caller names.
   * supplied/app: REQUIRED — the operator-declared machine/bot login (app: the App slug, without
   * `[bot]`). That is the account the operator created by hand, not necessarily the occupant.
   */
  expectedLogin?: string;
}

export type Grant = StationForgeApiGrant;
type StationRow = typeof stations.$inferSelect;
export interface GrantRef {
  tenantId: string;
  id: string;
}

// ─── State graph ──────────────────────────────────────────────────────────────

const ALLOWED: Record<ForgeGrantState, readonly ForgeGrantState[]> = {
  authorised: ["provisioned", "failed", "revoking"],
  // provisioned → provisioned: storing the blob, re-minting, or a retry that did not land.
  provisioned: ["provisioned", "delivered", "failed", "revoking"],
  // Self-edges: a rotation in progress, a re-verify, a re-supplied credential.
  delivered: ["delivered", "verified", "failed", "revoking"],
  // verified → delivered: a supplied/app credential replaced, awaiting its own verify.
  verified: ["verified", "delivered", "failed", "revoking"],
  // failed → provisioned: a retry; failed → failed: a retry that failed again; failed → verified:
  // a re-verify of a credential the node holds.
  failed: ["provisioned", "failed", "verified", "revoking"],
  revoking: ["revoking", "revoked", "failed"],
  // A tombstone is final.
  revoked: [],
};

export interface TransitionPatch {
  now: Date;
  /** Always written: a successful step clears the previous reason. */
  stateReason?: string | null;
  tokenHandle?: ForgeTokenHandle | null;
  generation?: number;
  isolation?: "separate-user" | "same-user" | null;
  deliveredAt?: Date | null;
  verifiedAt?: Date | null;
  /** Written as a pair or cleared as a pair (the table CHECKs it); omitted = unchanged. */
  sealed?: { blob: string; expiresAt: Date } | null;
}

/**
 * Move a grant from one of `from` to `to` in ONE UPDATE. Refuses an edge the graph does not have
 * (`bad-transition`) and a row that is no longer in any of `from` (`state-conflict`), so two
 * racing steps cannot both win. Returns the updated row.
 */
export async function transition(
  tx: DbExecutor,
  ref: GrantRef,
  from: ForgeGrantState[],
  to: ForgeGrantState,
  patch: TransitionPatch,
): Promise<Grant> {
  for (const f of from) {
    if (!ALLOWED[f].includes(to)) {
      throw new ForgeApiGrantError("bad-transition", `forge grant: ${f} → ${to} is not a lifecycle step.`, ref.id);
    }
  }
  const set: Partial<typeof g.$inferInsert> = {
    state: to,
    stateReason: patch.stateReason ?? null,
    updatedAt: patch.now,
    // The CHECK pairs these; nothing leaves `revoked`, so this is the whole rule.
    revokedAt: to === "revoked" ? patch.now : null,
  };
  if (patch.tokenHandle !== undefined) set.tokenHandle = patch.tokenHandle;
  if (patch.generation !== undefined) set.generation = patch.generation;
  if (patch.isolation !== undefined) set.isolation = patch.isolation;
  if (patch.deliveredAt !== undefined) set.deliveredAt = patch.deliveredAt;
  if (patch.verifiedAt !== undefined) set.verifiedAt = patch.verifiedAt;
  if (patch.sealed !== undefined) {
    set.sealedBlob = patch.sealed?.blob ?? null;
    set.sealedExpiresAt = patch.sealed?.expiresAt ?? null;
  }
  const [row] = await tx
    .update(g)
    .set(set)
    .where(and(eq(g.tenantId, ref.tenantId), eq(g.id, ref.id), inArray(g.state, from)))
    .returning();
  if (!row) {
    throw new ForgeApiGrantError(
      "state-conflict",
      `forge grant ${ref.id} is not in ${from.join("/")}; it changed underneath this step.`,
      ref.id,
    );
  }
  return row;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** An error's message, without the token if one is known, bounded. Never the error object. */
function scrub(err: unknown, secret?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (secret) msg = msg.split(secret).join("[redacted]");
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** A provider 404 on revoke means the token is already gone: the end state asked for. */
function isNotFound(err: unknown): boolean {
  if ((err as { status?: unknown })?.status === 404) return true;
  return err instanceof Error && /\bHTTP 404\b/.test(err.message);
}

/** Revoke, treating "already gone" as success. */
async function revokeTolerant(provider: ForgeProvider, account: string, handle: ForgeTokenRef) {
  if (!provider.revoke) throw new Error(`forge: ${provider.kind} cannot revoke tokens.`);
  try {
    await provider.revoke(account, handle);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** Best-effort compensation: never throws, never logs more than ids and a scrubbed message. */
async function compensateRevoke(
  provider: ForgeProvider,
  account: string,
  handle: ForgeTokenRef,
  grantId: string,
  secret?: string,
): Promise<boolean> {
  try {
    await revokeTolerant(provider, account, handle);
    return true;
  } catch (err) {
    log.warn("forge compensating revoke failed; reconcile will find the token by name", {
      grantId,
      tokenName: handle.name,
      error: scrub(err, secret),
    });
    return false;
  }
}

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

/** `forge-<provider>-<12 chars of the grant id>`: stable per grant, safe as an stk service name. */
export function serviceNameFor(grant: Pick<Grant, "id" | "provider">): string {
  const short = grant.id.replace(/[^a-zA-Z0-9]/g, "").slice(-12).toLowerCase();
  return `forge-${grant.provider}-${short}`;
}

async function loadStation(db: DbExecutor, tenantId: string, stationId: string): Promise<StationRow> {
  const [st] = await db
    .select()
    .from(stations)
    .where(and(eq(stations.tenantId, tenantId), eq(stations.id, stationId)));
  if (!st) throw new ForgeApiGrantError("station-not-found", `station ${stationId} not found.`);
  return st;
}

async function loadGrant(db: DbExecutor, ref: GrantRef): Promise<Grant> {
  const [row] = await db.select().from(g).where(and(eq(g.tenantId, ref.tenantId), eq(g.id, ref.id)));
  if (!row) throw new ForgeApiGrantError("grant-not-found", `forge grant ${ref.id} not found.`, ref.id);
  return row;
}

/**
 * Ask the node for the station's stk handover public key (`forge.api.status` → `publicKey`).
 * An offline node, an old node that does not know the verb, or one that answers without a key is
 * `station-key-unavailable` (502): the hub cannot seal, so it must not mint.
 */
export async function fetchStationPublicKey(
  deps: Pick<ForgeApiDeps, "broker">,
  station: { id: string; nodeId: string },
): Promise<string> {
  const params = VERB_PARAMS["forge.api.status"].parse({ stationId: station.id });
  const unavailable = (why: string) =>
    new ForgeApiGrantError("station-key-unavailable", `station ${station.id}: no stk handover key (${why}).`);
  let res: BrokerReply;
  try {
    res = await deps.broker.request(station.nodeId, "forge.api.status", params);
  } catch (err) {
    throw unavailable(scrub(err));
  }
  if (!res.ok) throw unavailable(scrub(res.error ?? "node error"));
  const parsed = VERB_RESULTS["forge.api.status"].safeParse(res.data);
  if (!parsed.success) throw unavailable("unreadable status reply");
  if (!parsed.data.publicKey) throw unavailable("the node did not report one");
  return parsed.data.publicKey;
}

function grantRef(row: Grant): ForgeGrantRef {
  return {
    id: row.id,
    provider: row.provider,
    instance: row.instance,
    mode: row.mode,
    account: row.account,
    expectedLogin: row.expectedLogin,
    preset: row.preset,
    repositories: row.repositories,
    generation: row.generation,
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

// ─── createForgeApiGrant ──────────────────────────────────────────────────────

/**
 * Grant a station repository-restricted API access, minted mode: validate, fetch the station's
 * public key, insert `authorised` (or find the live grant for the same station/provider/instance
 * and carry it forward instead of minting again), then mint, seal and deliver.
 *
 * Throws `ForgeApiGrantError`/`ForgeApiConfigError` for anything refused before a token exists and
 * for mint/seal faults. A delivery outcome (node offline, refused, no positive ack) is NOT thrown:
 * the returned row's `state` and `stateReason` say what happened.
 */
export async function createForgeApiGrant(deps: ForgeApiDeps, input: CreateForgeApiGrantInput): Promise<Grant> {
  const station = await loadStation(deps.db, input.tenantId, input.stationId);
  const minted = input.mode === "minted";

  // minted: the account is the occupant's handle, and nothing in `input` can name it.
  // supplied/app: the account is the machine/bot login the operator created and declares; the
  // occupant (if any) is still recorded as principalId.
  const principalId = station.principalId;
  let account: string | null;
  if (minted) {
    account = principalId ? await principalHandle(principalId) : null;
    if (!principalId || !account) {
      throw new ForgeApiGrantError("no-occupant", `station ${station.id} has no occupant to grant forge access to.`);
    }
  } else {
    account = input.expectedLogin?.trim() || null;
    if (!account) {
      throw new ForgeApiGrantError(
        "expected-login-required",
        `forge: a ${input.mode} grant needs the login the operator created (app: the App slug).`,
      );
    }
  }
  if (!(station.capabilities ?? []).includes("forge.api")) {
    throw new ForgeApiGrantError("capability-missing", `station ${station.id}'s node does not support forge.api; update the node.`);
  }
  const provider = deps.providers(input.provider);
  if (!provider.modes.includes(input.mode)) {
    throw new ForgeApiGrantError("mode-not-supported", `forge: ${input.provider} does not offer ${input.mode} grants.`);
  }
  for (const repo of input.repositories) {
    try {
      splitRepo(repo);
    } catch (err) {
      throw new ForgeApiGrantError("bad-repository", scrub(err));
    }
  }
  const probe: ForgeGrantRef = {
    id: "pending",
    provider: input.provider,
    instance: input.instance,
    mode: input.mode,
    account,
    expectedLogin: account,
    preset: input.preset,
    repositories: input.repositories,
    generation: 1,
  };
  if (minted) {
    // Scope check up front: a config mistake (preset "none", …) is a 422 before any row or token.
    provider.mintScopes(probe);
  } else {
    // The declared login must be one the provider can verify against (app: a slug, no "[bot]").
    try {
      provider.expectedIdentity(probe);
    } catch (err) {
      throw new ForgeApiGrantError("bad-expected-login", scrub(err));
    }
  }

  // BEFORE any mint: no key means no seal, and a token that cannot be sealed is an orphan.
  // supplied/app never mint and never seal: the operator sealed the credential client-side.
  const publicKey = minted ? await stationPublicKey(deps, station) : null;

  const now = deps.now();
  const { row, created } = await deps.db.transaction(async (tx) => {
    const findLive = async () =>
      (
        await tx
          .select()
          .from(g)
          .where(
            and(
              eq(g.tenantId, input.tenantId),
              eq(g.stationIdSnapshot, station.id),
              eq(g.provider, input.provider),
              eq(g.instance, input.instance),
              ne(g.state, "revoked"),
            ),
          )
      )[0];
    // Reusing a live row needs no generation. Otherwise take the (tenant, station, provider,
    // instance) lock via nextGeneration and look again under it, so a racing insert is seen.
    const seen = await findLive();
    if (seen) return { row: seen, created: false };
    const generation = await nextGeneration(tx, input.tenantId, station.id, input.provider, input.instance);
    const live = await findLive();
    if (live) return { row: live, created: false };
    const [inserted] = await tx
      .insert(g)
      .values({
        id: `fag_${crypto.randomUUID().replace(/-/g, "")}`,
        tenantId: input.tenantId,
        stationId: station.id,
        stationIdSnapshot: station.id,
        provider: input.provider,
        instance: input.instance,
        mode: input.mode,
        principalId,
        account,
        expectedLogin: account,
        repositories: input.repositories,
        preset: input.preset,
        rules: input.rules,
        allowGraphql: input.allowGraphql,
        state: "authorised",
        generation,
        createdBy: input.actor,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { row: inserted!, created: true };
  });

  if (!created) {
    const same =
      row.mode === input.mode &&
      row.preset === input.preset &&
      row.allowGraphql === input.allowGraphql &&
      row.account === account &&
      sameList(row.repositories, input.repositories) &&
      JSON.stringify(row.rules) === JSON.stringify(input.rules);
    if (!same) {
      throw new ForgeApiGrantError(
        "grant-exists",
        `station ${station.id} already has a ${row.provider} grant for ${row.instance} (${row.id}); revoke it first.`,
        row.id,
      );
    }
  }

  const audit = await recordAudit(deps.db, {
    userId: input.actor,
    nodeId: station.nodeId,
    stationKey: station.stationKey,
    verb: "forge.api.grant",
    // Only keys already on audit.ts's allowlist; the grant's own fields go there in Task 7.
    params: { stationKey: station.stationKey, key: row.id, kind: row.provider, action: `${row.mode}:${row.preset}` },
  });
  // supplied/app stop at `authorised`: the credential arrives through acceptSuppliedSecret.
  if (!minted) {
    await audit.done("ok", "awaiting the operator's sealed credential");
    return row;
  }
  try {
    const out = await advance(deps, row, station, provider, publicKey);
    await audit.done(out.state === "delivered" || out.state === "verified" ? "ok" : "error", out.stateReason ?? undefined);
    return out;
  } catch (err) {
    await audit.done("error", err instanceof ForgeApiGrantError ? err.message : "forge grant failed");
    throw err;
  }
}

async function stationPublicKey(deps: ForgeApiDeps, station: StationRow): Promise<string> {
  const lookup = deps.stationPublicKey ?? ((s: { id: string; nodeId: string }) => fetchStationPublicKey(deps, s));
  return lookup({ id: station.id, nodeId: station.nodeId });
}

// ─── deliverGrant ─────────────────────────────────────────────────────────────

/**
 * Carry a grant forward: re-send a live sealed blob without minting, or, when the blob has expired
 * or was never stored, revoke the old token and mint generation + 1. Delivered/verified grants are
 * returned unchanged; revoking/revoked ones are refused. Same return/throw contract as
 * `createForgeApiGrant`.
 */
export async function deliverGrant(deps: ForgeApiDeps, ref: { tenantId: string; grantId: string }): Promise<Grant> {
  const row = await loadGrant(deps.db, { tenantId: ref.tenantId, id: ref.grantId });
  if (row.state === "delivered" || row.state === "verified") return row;
  if (row.state === "revoking" || row.state === "revoked") {
    throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id} is ${row.state}.`, row.id);
  }
  if (!row.stationId) {
    throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id}'s station is gone.`, row.id);
  }
  const station = await loadStation(deps.db, row.tenantId, row.stationId);
  const provider = deps.providers(row.provider);
  const blobLive = row.sealedBlob && row.sealedExpiresAt && row.sealedExpiresAt.getTime() > deps.now().getTime();
  if (!blobLive && row.mode !== "minted") throw needsOperatorCredential(row);
  // Only a path that mints needs the key; fetch it before that mint, never after.
  const publicKey = blobLive ? null : await stationPublicKey(deps, station);
  return advance(deps, row, station, provider, publicKey);
}

// ─── The steps ────────────────────────────────────────────────────────────────

async function advance(
  deps: ForgeApiDeps,
  stale: Grant,
  station: StationRow,
  provider: ForgeProvider,
  publicKey: string | null,
): Promise<Grant> {
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    // Re-read under the claim: a request that held it before us may have moved the grant on.
    const row = await loadGrant(deps.db, stale);
    if (row.state === "revoking" || row.state === "revoked") {
      throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id} is ${row.state}.`, row.id);
    }
    return advanceClaimed(deps, row, station, provider, publicKey);
  });
}

async function advanceClaimed(
  deps: ForgeApiDeps,
  row: Grant,
  station: StationRow,
  provider: ForgeProvider,
  publicKey: string | null,
): Promise<Grant> {
  if (row.state === "delivered" || row.state === "verified") return row;
  const now = deps.now();
  const blobLive = row.sealedBlob && row.sealedExpiresAt && row.sealedExpiresAt.getTime() > now.getTime();
  if (blobLive) return sendDeliver(deps, row, station, row.sealedBlob!);
  // Never mint for a supplied/app grant: only the operator can produce its credential.
  if (row.mode !== "minted") throw needsOperatorCredential(row);
  if (!publicKey) {
    throw new ForgeApiGrantError("station-key-unavailable", `station ${station.id}: no stk handover key.`, row.id);
  }

  let current = row;
  if (current.tokenHandle) {
    // A token exists but no deliverable blob does, and the hub has no plaintext to re-seal.
    // Revoke it, then mint the next generation (spec: sealed-blob expiry).
    try {
      await revokeTolerant(provider, current.account, current.tokenHandle);
    } catch (err) {
      const reason = `re-mint blocked: revoking the undelivered token failed: ${scrub(err)}`;
      await transition(deps.db, current, [current.state], "failed", { now, stateReason: reason });
      log.warn("forge grant re-mint blocked", { grantId: current.id, stationId: station.id });
      throw new ForgeApiGrantError("revoke-failed", reason, current.id);
    }
    current = await deps.db.transaction(async (tx) => {
      const generation = await nextGeneration(tx, current.tenantId, current.stationIdSnapshot, current.provider, current.instance);
      return transition(tx, current, [current.state], "provisioned", {
        now,
        generation,
        tokenHandle: null,
        sealed: null,
        stateReason: "re-minting: the sealed blob expired before delivery",
      });
    });
  }
  return mintAndDeliver(deps, current, station, provider, publicKey);
}

/** The only function that ever holds the token. */
async function mintAndDeliver(
  deps: ForgeApiDeps,
  row: Grant,
  station: StationRow,
  provider: ForgeProvider,
  publicKey: string,
): Promise<Grant> {
  const ref = grantRef(row);
  const scopes = provider.mintScopes(ref);
  if (!provider.mint) throw new ForgeApiGrantError("mode-not-supported", `forge: ${provider.kind} cannot mint tokens.`, row.id);
  const name = tokenName(ref);
  const repositories = row.repositories.map(splitRepo);

  let minted: { id: number | undefined; name: string; secret: string };
  try {
    minted = await provider.mint(row.account, { name, scopes, repositories });
  } catch (err) {
    // Ambiguous: a timeout or 5xx may have created the token anyway. Revoke by the deterministic
    // name (best effort) so a retry can never leave two tokens under one name.
    await compensateRevoke(provider, row.account, { name }, row.id);
    const reason = `mint failed: ${scrub(err)}`;
    await transition(deps.db, row, [row.state], "failed", { now: deps.now(), stateReason: reason });
    log.warn("forge token mint failed", { grantId: row.id, stationId: station.id });
    throw new ForgeApiGrantError("mint-failed", reason, row.id);
  }
  let secret: string | undefined = minted.secret;
  const handle = minted.id === undefined ? { name: minted.name } : { id: minted.id, name: minted.name };

  // Persist the handle BEFORE sealing or delivering, so reconcile can always find this token.
  let current: Grant;
  try {
    current = await transition(deps.db, row, [row.state], "provisioned", { now: deps.now(), tokenHandle: handle });
  } catch (err) {
    // The token exists and nothing records it: take it back before anything else.
    await compensateRevoke(provider, row.account, handle, row.id, secret);
    secret = undefined;
    log.warn("forge token handle could not be persisted; minted token revoked", { grantId: row.id, stationId: station.id });
    throw new ForgeApiGrantError(
      "handle-persist-failed",
      `forge grant ${row.id}: the minted token could not be recorded (${scrub(err, minted.secret)}); it was revoked.`,
      row.id,
    );
  }

  let sealed: string;
  try {
    sealed = await deps.seal(publicKey, { token: secret });
  } catch (err) {
    const reason = `seal failed: ${scrub(err, secret)}`;
    secret = undefined;
    await transition(deps.db, current, ["provisioned"], "provisioned", { now: deps.now(), stateReason: reason });
    log.warn("forge token seal failed", { grantId: row.id, stationId: station.id });
    throw new ForgeApiGrantError("seal-failed", `forge grant ${row.id}: sealing the token failed.`, row.id);
  }
  secret = undefined;

  const now = deps.now();
  current = await transition(deps.db, current, ["provisioned"], "provisioned", {
    now,
    sealed: { blob: sealed, expiresAt: new Date(now.getTime() + SEALED_BLOB_TTL_MS) },
  });
  log.info("forge token minted and sealed", { grantId: row.id, stationId: station.id, generation: current.generation });
  return sendDeliver(deps, current, station, sealed);
}

/** Retryable transport failures: the frame may never have reached the node. */
const TRANSIENT = new Set(["node offline", "timeout", "node disconnected"]);

type DeliverOutcome =
  | { kind: "acked"; isolation: "separate-user" | "same-user" }
  /** The frame may never have reached the node: retry with the same blob. */
  | { kind: "transient"; reason: string }
  /** The node said no, or did not positively confirm: not delivered. */
  | { kind: "refused"; reason: string };

/**
 * Validate and send one `forge.api.deliver` frame and classify the reply. Writes nothing; callers
 * decide what each outcome means for their state. Reasons never carry the blob.
 */
async function relayDeliver(deps: ForgeApiDeps, row: Grant, station: StationRow, sealed: string): Promise<DeliverOutcome> {
  const frame = VERB_PARAMS["forge.api.deliver"].safeParse({
    stationId: station.id,
    stationKey: station.stationKey,
    grantId: row.id,
    provider: row.provider,
    instance: row.instance,
    mode: row.mode,
    serviceName: serviceNameFor(row),
    repositories: row.repositories,
    preset: row.preset,
    rules: row.rules,
    allowGraphql: row.allowGraphql,
    sealed,
    expectLogin: expectLoginFor(deps, row),
  });
  if (!frame.success) {
    // Paths only, never values: a value could be the blob.
    const where = frame.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    return { kind: "refused", reason: `invalid deliver frame (${where}); nothing was sent` };
  }

  let res: BrokerReply;
  try {
    res = await deps.broker.request(station.nodeId, "forge.api.deliver", frame.data);
  } catch (err) {
    return { kind: "transient", reason: `delivery not attempted: ${scrub(err, sealed)}` };
  }
  if (!res.ok) {
    const error = scrub(res.error ?? "node error", sealed);
    return TRANSIENT.has(error)
      ? { kind: "transient", reason: `delivery failed: ${error}; will retry` }
      : { kind: "refused", reason: `node refused delivery: ${error}` };
  }
  const ack = VERB_RESULTS["forge.api.deliver"].safeParse(res.data);
  if (!ack.success) return { kind: "refused", reason: "node acknowledged delivery with an unreadable reply" };
  if (ack.data.ok !== true || ack.data.stored !== true) {
    return {
      kind: "refused",
      reason: `node did not confirm the token was stored (ok=${ack.data.ok}, stored=${ack.data.stored})`,
    };
  }
  return { kind: "acked", isolation: ack.data.isolation };
}

/**
 * The login the node must see. minted: the stored expected login (the occupant). supplied/app: the
 * provider's view of the declared login (GitHub app: `<slug>[bot]`).
 */
function expectLoginFor(deps: Pick<ForgeApiDeps, "providers">, row: Grant): string {
  if (row.mode === "minted") return row.expectedLogin ?? row.account;
  return deps.providers(row.provider).expectedIdentity(grantRef(row));
}

async function sendDeliver(deps: ForgeApiDeps, row: Grant, station: StationRow, sealed: string): Promise<Grant> {
  const out = await relayDeliver(deps, row, station, sealed);
  if (out.kind !== "acked") {
    // A failed or unreadable ack keeps the sealed blob by design: it is ciphertext only the node can
    // open, it expires after 24 h, and keeping it lets a retry re-send instead of re-minting.
    // From delivered/verified (a re-supplied credential) a transient failure keeps the state.
    const to: ForgeGrantState =
      out.kind === "refused" ? "failed" : row.state === "delivered" || row.state === "verified" ? row.state : "provisioned";
    log.warn("forge grant not delivered", { grantId: row.id, stationId: station.id, state: to, reason: out.reason });
    return transition(deps.db, row, [row.state], to, { now: deps.now(), stateReason: out.reason });
  }
  const done = await transition(deps.db, row, [row.state], "delivered", {
    now: deps.now(),
    deliveredAt: deps.now(),
    isolation: out.isolation,
    sealed: null,
  });
  log.info("forge grant delivered", { grantId: row.id, stationId: station.id, isolation: out.isolation });
  return done;
}

function needsOperatorCredential(row: Grant): ForgeApiGrantError {
  return new ForgeApiGrantError(
    "grant-not-deliverable",
    `forge grant ${row.id} (${row.mode}) has no deliverable credential; the operator must supply a new sealed one.`,
    row.id,
  );
}

// ═══ After delivery: verify, rotate, revoke, policy; supplied and app modes ═══════════════════
//
// The rules this half keeps:
//
// - **Every mutating operation runs inside `withGrantClaim`**, so a rotate and a revoke on one
//   grant cannot interleave: the second is `grant-busy`. Helpers named `*Claimed` assume the claim.
// - **Frames are validated before `broker.request` and replies parsed with VERB_RESULTS**; only a
//   positive acknowledgement counts. Node offline/timeout is a typed outcome that changes nothing.
// - **Node text is untrusted**: a reason or login from the node is stripped of control characters
//   and capped at 200 characters before it is stored (`untrusted`).
// - **Rotation (minted)**: the previous handle is persisted (inside `token_handle.previous`) BEFORE
//   the new token is minted, so a crash at any point leaves both handles findable. The old
//   generation is revoked only after the new one verifies; any failure before that revokes the NEW
//   token (best effort; kept as `previous` if that fails) and restores the old handle/generation.
// - **Revocation**: one UPDATE to `revoking`, then the provider FIRST (minted: current + previous
//   handle, 404 = success; app: nothing, installation tokens expire; supplied: agentpod cannot, so
//   `revocation-pending-operator` until `confirmSuppliedRevoked`), then the node wipe best effort,
//   then `revoked` in one UPDATE. A revoke never mints and never needs the station key. A pending
//   step is recorded as the reason's leading code, and a retry resumes from it:
//     `revoke-pending-retry` provider failed; nothing sent to the node yet; retry from the top
//     `revocation-pending-operator` supplied: the operator must revoke at the provider
//     `wipe-pending` provider done; the node's stk entry still needs wiping (Task 8 reconnect)
//     `wipe-pending: station-gone` the station row is gone, so its node cannot be addressed
// - **Policy** is not a transition: the row's policy is updated in one UPDATE that keeps the state;
//   if the node cannot apply it the DB keeps the new policy and the reason says `policy-pending`
//   (the next deliver frame carries the policy too, so nothing is lost by not rolling back).
// - **The hub never opens a supplied/app blob**: it checks the envelope prefix and size and relays
//   it byte-identical.

/** Supplied/app sealed credentials are small: a PAT or an App key. */
export const SUPPLIED_BLOB_MAX = 16 * 1024;

const NODE_REASON_MAX = 200;

/** A node-supplied string, safe to store: control characters removed, length capped. */
function untrusted(s: unknown): string {
  const clean = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > NODE_REASON_MAX ? `${clean.slice(0, NODE_REASON_MAX)}…` : clean;
}

type Ref = { tenantId: string; grantId: string };
const toRef = (r: Ref): GrantRef => ({ tenantId: r.tenantId, id: r.grantId });

function isUnknownVerb(error: string): boolean {
  return /unknown verb/i.test(error);
}

// ─── verify ───────────────────────────────────────────────────────────────────

type VerifyAnswer =
  | { kind: "ok"; login: string; isolation: "separate-user" | "same-user" }
  | { kind: "failed"; reason: string }
  | { kind: "offline"; reason: string };

/** Ask the node to make a real read call as the grant's credential. Writes nothing. */
async function askVerify(deps: ForgeApiDeps, row: Grant, station: { id: string; nodeId: string }): Promise<VerifyAnswer> {
  let expectLogin: string;
  try {
    expectLogin = expectLoginFor(deps, row);
  } catch (err) {
    return { kind: "failed", reason: `verify-failed: ${scrub(err)}` };
  }
  const params = VERB_PARAMS["forge.api.verify"].safeParse({ stationId: station.id, grantId: row.id, expectLogin });
  if (!params.success) return { kind: "failed", reason: "verify-failed: invalid verify frame; nothing was sent" };
  let res: BrokerReply;
  try {
    res = await deps.broker.request(station.nodeId, "forge.api.verify", params.data);
  } catch (err) {
    return { kind: "offline", reason: `verify not attempted: ${untrusted(scrub(err))}` };
  }
  if (!res.ok) {
    const error = untrusted(res.error ?? "node error");
    if (TRANSIENT.has(error)) return { kind: "offline", reason: `verify not attempted: ${error}` };
    if (isUnknownVerb(error)) return { kind: "failed", reason: "node-too-old: the node does not know forge.api.verify" };
    return { kind: "failed", reason: `verify-failed: ${error}` };
  }
  const parsed = VERB_RESULTS["forge.api.verify"].safeParse(res.data);
  if (!parsed.success) return { kind: "failed", reason: "verify-failed: unreadable verify reply" };
  const r = parsed.data;
  if (r.ok !== true) return { kind: "failed", reason: `verify-failed: ${untrusted(r.reason ?? "no reason given")}` };
  if (!r.login || r.login.toLowerCase() !== expectLogin.toLowerCase()) {
    return {
      kind: "failed",
      reason: `wrong-identity: expected ${untrusted(expectLogin)}, the forge answered as ${untrusted(r.login ?? "(nobody)")}`,
    };
  }
  return { kind: "ok", login: r.login, isolation: r.isolation };
}

export interface VerifyResult {
  outcome: "verified" | "failed" | "node-offline";
  grant: Grant;
}

function assertVerifiable(row: Grant): void {
  const ok =
    row.state === "delivered" ||
    row.state === "verified" ||
    // A failed grant the node may still hold: minted with a handle, or supplied/app once delivered.
    (row.state === "failed" && (row.mode === "minted" ? row.tokenHandle !== null : row.deliveredAt !== null));
  if (!ok) {
    throw new ForgeApiGrantError("grant-not-verifiable", `forge grant ${row.id} is ${row.state}; nothing to verify.`, row.id);
  }
}

/**
 * `forge.api.verify` with the provider's expected identity. Match (case-insensitive) → `verified`;
 * a wrong login → `failed wrong-identity`; a negative answer → `failed` with the node's reason
 * (sanitised); an old node → `failed node-too-old`; offline/timeout → unchanged, `node-offline`.
 */
export async function verifyGrant(deps: ForgeApiDeps, ref: Ref): Promise<VerifyResult> {
  const stale = await loadGrant(deps.db, toRef(ref));
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    assertVerifiable(row);
    if (!row.stationId) {
      throw new ForgeApiGrantError("grant-not-verifiable", `forge grant ${row.id}'s station is gone.`, row.id);
    }
    const station = await loadStation(deps.db, row.tenantId, row.stationId);
    const answer = await askVerify(deps, row, station);
    if (answer.kind === "offline") {
      log.info("forge grant verify deferred: node unreachable", { grantId: row.id, stationId: station.id });
      return { outcome: "node-offline", grant: row };
    }
    if (answer.kind === "failed") {
      log.warn("forge grant failed verification", { grantId: row.id, stationId: station.id, reason: answer.reason });
      const grant = await transition(deps.db, row, [row.state], "failed", { now: deps.now(), stateReason: answer.reason });
      return { outcome: "failed", grant };
    }
    const now = deps.now();
    const grant = await transition(deps.db, row, [row.state], "verified", { now, verifiedAt: now, isolation: answer.isolation });
    log.info("forge grant verified", { grantId: row.id, stationId: station.id });
    return { outcome: "verified", grant };
  });
}

// ─── rotate (minted) ──────────────────────────────────────────────────────────

const bareHandle = (h: ForgeTokenRef): ForgeTokenRef => (h.id === undefined ? { name: h.name } : { id: h.id, name: h.name });

/**
 * Minted rotation: mint generation n+1, deliver, verify, THEN revoke generation n. Supplied and
 * app grants rotate by the operator supplying a new sealed credential (`acceptSuppliedSecret`).
 *
 * Returns the verified row. Throws `rotation-failed` when the new token could not be delivered or
 * verified: generation n is still live and the row is back on it with reason `rotation-failed`.
 * An unreachable node is found before any mint (`station-key-unavailable`), changing nothing.
 */
export async function rotateGrant(deps: ForgeApiDeps, ref: Ref): Promise<Grant> {
  const stale = await loadGrant(deps.db, toRef(ref));
  if (stale.mode !== "minted") {
    throw new ForgeApiGrantError(
      "mode-not-supported",
      `forge grant ${stale.id} is ${stale.mode}: rotate it by supplying a new sealed credential.`,
      stale.id,
    );
  }
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    if ((row.state !== "delivered" && row.state !== "verified") || !row.tokenHandle) {
      throw new ForgeApiGrantError("grant-not-rotatable", `forge grant ${row.id} is ${row.state}; only a delivered grant rotates.`, row.id);
    }
    if (row.tokenHandle.previous) {
      throw new ForgeApiGrantError(
        "grant-not-rotatable",
        `forge grant ${row.id} still has a superseded token to revoke; reconcile must finish it first.`,
        row.id,
      );
    }
    if (!row.stationId) {
      throw new ForgeApiGrantError("grant-not-rotatable", `forge grant ${row.id}'s station is gone.`, row.id);
    }
    const station = await loadStation(deps.db, row.tenantId, row.stationId);
    const provider = deps.providers(row.provider);
    if (!provider.mint) throw new ForgeApiGrantError("mode-not-supported", `forge: ${provider.kind} cannot mint tokens.`, row.id);
    // Before any mint: proves the node is reachable and gives the key to seal to.
    const publicKey = await stationPublicKey(deps, station);
    return rotateClaimed(deps, row, station, provider, publicKey);
  });
}

async function rotateClaimed(
  deps: ForgeApiDeps,
  before: Grant,
  station: StationRow,
  provider: ForgeProvider,
  publicKey: string,
): Promise<Grant> {
  const oldHandle = bareHandle(before.tokenHandle!);
  const priorState = before.state as "delivered" | "verified";

  // 1. Persist the old handle as `previous` and the next generation's deterministic name, BEFORE
  //    minting: a crash from here on leaves both tokens findable by handle or name.
  let row = await deps.db.transaction(async (tx) => {
    const generation = await nextGeneration(tx, before.tenantId, before.stationIdSnapshot, before.provider, before.instance);
    return transition(tx, before, [priorState], priorState, {
      now: deps.now(),
      generation,
      tokenHandle: { name: tokenName({ id: before.id, generation }), previous: oldHandle },
      stateReason: `rotating to generation ${generation}`,
    });
  });
  const newName = row.tokenHandle!.name;

  /** Take back the new token, put the row back on the old one, and report rotation-failed. */
  const abort = async (why: string, newHandle: ForgeTokenRef, secret?: string): Promise<never> => {
    const gone = await compensateRevoke(provider, row.account, newHandle, row.id, secret);
    const reason = `rotation-failed: ${why}`;
    await transition(deps.db, row, [priorState], priorState, {
      now: deps.now(),
      generation: before.generation,
      // A new token that could not be revoked stays recorded so reconcile can take it back.
      tokenHandle: gone ? oldHandle : { ...oldHandle, previous: newHandle },
      stateReason: reason,
    });
    log.warn("forge grant rotation failed; the previous token stays live", { grantId: row.id, stationId: station.id, reason });
    throw new ForgeApiGrantError("rotation-failed", `forge grant ${row.id}: ${reason}`, row.id);
  };

  // 2. Mint generation n+1. The token lives in `secret` until it is sealed.
  const ref = grantRef(row);
  let minted: { id: number | undefined; name: string; secret: string };
  try {
    minted = await provider.mint!(row.account, {
      name: newName,
      scopes: provider.mintScopes(ref),
      repositories: row.repositories.map(splitRepo),
    });
  } catch (err) {
    return abort(`mint failed: ${scrub(err)}`, { name: newName });
  }
  let secret: string | undefined = minted.secret;
  const newHandle: ForgeTokenRef = minted.id === undefined ? { name: minted.name } : { id: minted.id, name: minted.name };
  try {
    row = await transition(deps.db, row, [priorState], priorState, {
      now: deps.now(),
      tokenHandle: { ...newHandle, previous: oldHandle },
      stateReason: row.stateReason,
    });
  } catch (err) {
    const s = secret;
    secret = undefined;
    return abort(`the new token could not be recorded (${scrub(err, s)})`, newHandle, s);
  }

  // 3. Seal and deliver: the node replaces its stored credential.
  let sealed: string;
  try {
    sealed = await deps.seal(publicKey, { token: secret });
  } catch (err) {
    const why = `seal failed: ${scrub(err, secret)}`;
    secret = undefined;
    return abort(why, newHandle);
  }
  secret = undefined;
  const delivery = await relayDeliver(deps, row, station, sealed);
  if (delivery.kind !== "acked") return abort(delivery.reason, newHandle);

  // 4. Verify the new token as the right account. Anything but a match aborts.
  const answer = await askVerify(deps, row, station);
  if (answer.kind !== "ok") return abort(answer.reason, newHandle);

  const now = deps.now();
  row = await transition(deps.db, row, [priorState], "verified", {
    now,
    deliveredAt: now,
    verifiedAt: now,
    isolation: answer.isolation,
    sealed: null,
    stateReason: `rotated; revoking generation ${before.generation}`,
  });

  // 5. Only now revoke generation n. A failure keeps it as `previous` for reconcile.
  try {
    await revokeTolerant(provider, row.account, oldHandle);
  } catch (err) {
    log.warn("forge grant rotated but the old token is not revoked yet", { grantId: row.id, stationId: station.id });
    return transition(deps.db, row, ["verified"], "verified", {
      now: deps.now(),
      stateReason: `previous-revoke-pending: ${scrub(err)}`,
    });
  }
  row = await transition(deps.db, row, ["verified"], "verified", { now: deps.now(), tokenHandle: newHandle });
  log.info("forge grant rotated", { grantId: row.id, stationId: station.id, generation: row.generation });
  return row;
}

// ─── revoke ───────────────────────────────────────────────────────────────────

export interface RevokeResult {
  /**
   * revoked: both sides done. pending: the provider step failed, retry. pending-operator: a
   * supplied credential the operator must revoke. wipe-pending: provider done, node wipe queued.
   */
  outcome: "revoked" | "pending" | "pending-operator" | "wipe-pending";
  grant: Grant;
}

const PENDING_OPERATOR = "revocation-pending-operator";
const WIPE_PENDING = "wipe-pending";

/** Ask the node to wipe its stk entry. Returns null when done, else why it is still pending. */
async function wipeOnNode(deps: ForgeApiDeps, row: Grant): Promise<string | null> {
  if (!row.stationId) return `${WIPE_PENDING}: station-gone`;
  const [st] = await deps.db
    .select()
    .from(stations)
    .where(and(eq(stations.tenantId, row.tenantId), eq(stations.id, row.stationId)));
  if (!st) return `${WIPE_PENDING}: station-gone`;
  const params = VERB_PARAMS["forge.api.revoke"].safeParse({ stationId: st.id, grantId: row.id });
  if (!params.success) return `${WIPE_PENDING}: invalid revoke frame`;
  let res: BrokerReply;
  try {
    res = await deps.broker.request(st.nodeId, "forge.api.revoke", params.data);
  } catch (err) {
    return `${WIPE_PENDING}: ${untrusted(scrub(err))}`;
  }
  if (!res.ok) {
    const error = untrusted(res.error ?? "node error");
    return isUnknownVerb(error) ? `${WIPE_PENDING}: node-too-old` : `${WIPE_PENDING}: ${error}`;
  }
  // removed:false means there was nothing to remove: the entry is gone either way.
  if (!VERB_RESULTS["forge.api.revoke"].safeParse(res.data).success) return `${WIPE_PENDING}: unreadable revoke reply`;
  return null;
}

/**
 * Revoke a grant: `revoking`, provider first, node wipe best effort, then `revoked`. Re-entrant:
 * calling it again on a `revoking` grant resumes the step its reason records (reconcile does this).
 * Works with the station gone. Never mints, never needs the station key.
 */
export async function revokeGrant(deps: ForgeApiDeps, ref: Ref): Promise<RevokeResult> {
  const stale = await loadGrant(deps.db, toRef(ref));
  if (stale.state === "revoked") return { outcome: "revoked", grant: stale };
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    let row = await loadGrant(deps.db, stale);
    if (row.state === "revoked") return { outcome: "revoked", grant: row };
    const resumeWipeOnly = row.state === "revoking" && (row.stateReason ?? "").startsWith(WIPE_PENDING);
    if (row.state !== "revoking") {
      // One UPDATE; any undelivered blob goes with it.
      row = await transition(deps.db, row, [row.state], "revoking", { now: deps.now(), stateReason: "revoking", sealed: null });
    }

    // 1. Provider side.
    let providerDone: boolean;
    if (resumeWipeOnly) {
      providerDone = true;
    } else if (row.mode === "minted") {
      const provider = deps.providers(row.provider);
      const handles = [row.tokenHandle, row.tokenHandle?.previous].filter((h): h is ForgeTokenRef => !!h).map(bareHandle);
      try {
        for (const h of handles) await revokeTolerant(provider, row.account, h);
        providerDone = true;
      } catch (err) {
        const reason = `revoke-pending-retry: ${scrub(err)}`;
        log.warn("forge grant revoke at the provider failed; will retry", { grantId: row.id, stationId: row.stationIdSnapshot });
        const grant = await transition(deps.db, row, ["revoking"], "revoking", { now: deps.now(), stateReason: reason });
        return { outcome: "pending", grant };
      }
    } else if (row.mode === "app") {
      // Nothing to revoke: stk exchanges the App key for installation tokens that expire in about
      // an hour. The operator removes the App key on GitHub if the App itself should go.
      providerDone = true;
    } else {
      // supplied: agentpod cannot revoke an operator-made token.
      providerDone = false;
    }

    // 2. Node wipe, best effort.
    const wipePending = await wipeOnNode(deps, row);

    // 3. Settle.
    if (providerDone && !wipePending) {
      const grant = await transition(deps.db, row, ["revoking"], "revoked", { now: deps.now(), stateReason: null });
      log.info("forge grant revoked", { grantId: row.id, stationId: row.stationIdSnapshot });
      return { outcome: "revoked", grant };
    }
    if (!providerDone) {
      const reason = `${PENDING_OPERATOR}: the operator must revoke this token at the provider${wipePending ? `; ${wipePending}` : ""}`;
      const grant = await transition(deps.db, row, ["revoking"], "revoking", { now: deps.now(), stateReason: reason });
      return { outcome: "pending-operator", grant };
    }
    const grant = await transition(deps.db, row, ["revoking"], "revoking", { now: deps.now(), stateReason: wipePending });
    log.info("forge grant revoked at the provider; node wipe queued", { grantId: row.id, stationId: row.stationIdSnapshot });
    return { outcome: "wipe-pending", grant };
  });
}

/**
 * The operator confirms a supplied token is revoked at the provider. Completes the revocation, or
 * leaves `wipe-pending` if the node wipe has not happened yet (it is retried here first).
 */
export async function confirmSuppliedRevoked(deps: ForgeApiDeps, ref: Ref): Promise<RevokeResult> {
  const stale = await loadGrant(deps.db, toRef(ref));
  if (stale.mode !== "supplied") {
    throw new ForgeApiGrantError("mode-not-supported", `forge grant ${stale.id} is ${stale.mode}; only supplied grants need an operator confirmation.`, stale.id);
  }
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    if (row.state === "revoked") return { outcome: "revoked", grant: row };
    if (row.state !== "revoking") {
      throw new ForgeApiGrantError("bad-transition", `forge grant ${row.id} is ${row.state}; revoke it first.`, row.id);
    }
    const wipePending = (row.stateReason ?? "").includes(WIPE_PENDING) ? await wipeOnNode(deps, row) : null;
    if (!wipePending) {
      const grant = await transition(deps.db, row, ["revoking"], "revoked", { now: deps.now(), stateReason: null });
      return { outcome: "revoked", grant };
    }
    const grant = await transition(deps.db, row, ["revoking"], "revoking", { now: deps.now(), stateReason: wipePending });
    return { outcome: "wipe-pending", grant };
  });
}

// ─── supplied and app credentials ─────────────────────────────────────────────

export interface AcceptSuppliedInput extends Ref {
  /** The credential, sealed client-side by the operator to the station's stk key. Never opened here. */
  sealed: string;
}

/**
 * Relay an operator-sealed credential (supplied token or App key) to the node. The hub checks the
 * envelope prefix and size only, stores the blob for 24 h until acknowledged (like a minted
 * delivery), and sends it byte-identical. Also the rotation path for supplied/app grants.
 */
export async function acceptSuppliedSecret(deps: ForgeApiDeps, input: AcceptSuppliedInput): Promise<Grant> {
  const sealed = input.sealed;
  if (
    typeof sealed !== "string" ||
    !sealed.startsWith(STK_HANDOVER_PREFIX) ||
    sealed.length <= STK_HANDOVER_PREFIX.length ||
    sealed.length > SUPPLIED_BLOB_MAX
  ) {
    // Never echo the value: it may be a plaintext token pasted by mistake.
    throw new ForgeApiGrantError(
      "bad-sealed-blob",
      `forge: a supplied credential must be a ${STK_HANDOVER_PREFIX} envelope of at most ${SUPPLIED_BLOB_MAX} bytes.`,
      input.grantId,
    );
  }
  const stale = await loadGrant(deps.db, toRef(input));
  if (stale.mode === "minted") {
    throw new ForgeApiGrantError("mode-not-supported", `forge grant ${stale.id} is minted; the hub makes its token.`, stale.id);
  }
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    if (row.state === "revoking" || row.state === "revoked") {
      throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id} is ${row.state}.`, row.id);
    }
    if (!row.stationId) {
      throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id}'s station is gone.`, row.id);
    }
    const station = await loadStation(deps.db, row.tenantId, row.stationId);
    const now = deps.now();
    // authorised/failed/provisioned → provisioned; delivered/verified keep their state until acked.
    const to: ForgeGrantState = row.state === "delivered" || row.state === "verified" ? row.state : "provisioned";
    const stored = await transition(deps.db, row, [row.state], to, {
      now,
      sealed: { blob: sealed, expiresAt: new Date(now.getTime() + SEALED_BLOB_TTL_MS) },
    });
    return sendDeliver(deps, stored, station, sealed);
  });
}

/** App mode in one call: create the grant (App slug as `expectedLogin`) and relay the sealed App key. */
export async function registerAppGrant(deps: ForgeApiDeps, input: CreateForgeApiGrantInput & { sealed: string }): Promise<Grant> {
  if (input.mode !== "app") {
    throw new ForgeApiGrantError("mode-not-supported", `forge: registerAppGrant is for app grants, not ${input.mode}.`);
  }
  const { sealed, ...grantInput } = input;
  const grant = await createForgeApiGrant(deps, grantInput);
  return acceptSuppliedSecret(deps, { tenantId: grant.tenantId, grantId: grant.id, sealed });
}

// ─── policy ───────────────────────────────────────────────────────────────────

export interface UpdatePolicyInput extends Ref {
  preset: ForgeApiPreset;
  rules: ForgeApiRule[];
  allowGraphql: boolean;
}

export interface PolicyResult {
  /** applied: the node confirmed. stored: the node has no credential yet; the next deliver carries it. pending: saved, node not confirmed. */
  outcome: "applied" | "stored" | "pending";
  grant: Grant;
}

const RULE_TARGET = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|\*) \/\S*$/;

/** Syntax only. The real check is stk's at reload; this rejects the obviously malformed. */
function checkPolicy(input: UpdatePolicyInput): void {
  const bad = (why: string) => new ForgeApiGrantError("bad-policy", `forge policy: ${why}.`, input.grantId);
  if (!ForgeApiPresetSchema.safeParse(input.preset).success) throw bad("unknown preset");
  if (typeof input.allowGraphql !== "boolean") throw bad("allowGraphql must be a boolean");
  if (!Array.isArray(input.rules)) throw bad("rules must be a list");
  input.rules.forEach((rule, i) => {
    if (!ForgeApiRuleSchema.safeParse(rule).success) throw bad(`rule ${i} has unknown fields or wrong types`);
    const targets = [rule.allow, rule.deny].filter((t) => t !== undefined);
    if (targets.length !== 1) throw bad(`rule ${i} needs exactly one of allow or deny`);
    if (!RULE_TARGET.test(targets[0]!)) throw bad(`rule ${i} must be "METHOD /path"`);
  });
}

/**
 * Change a grant's preset/rules/GraphQL switch. One UPDATE that keeps the state; then
 * `forge.api.policy` to a node that holds the credential (positive ack required). A node that cannot
 * apply it leaves the DB policy in place and the reason `policy-pending` (not rolled back: the
 * policy is the operator's intent, and every later deliver frame carries it). For a minted grant
 * the token's scopes follow the preset only from the next mint (rotate to widen them).
 */
export async function updateGrantPolicy(deps: ForgeApiDeps, input: UpdatePolicyInput): Promise<PolicyResult> {
  checkPolicy(input);
  const stale = await loadGrant(deps.db, toRef(input));
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    if (row.state === "revoking" || row.state === "revoked") {
      throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id} is ${row.state}.`, row.id);
    }
    const onNode = (row.state === "delivered" || row.state === "verified") && row.stationId !== null;
    const save = async (reason: string | null | undefined, from: ForgeGrantState[]) => {
      const set: Partial<typeof g.$inferInsert> = {
        preset: input.preset,
        rules: input.rules,
        allowGraphql: input.allowGraphql,
        updatedAt: deps.now(),
      };
      if (reason !== undefined) set.stateReason = reason;
      const [out] = await deps.db
        .update(g)
        .set(set)
        .where(and(eq(g.tenantId, row.tenantId), eq(g.id, row.id), inArray(g.state, from)))
        .returning();
      if (!out) throw new ForgeApiGrantError("state-conflict", `forge grant ${row.id} changed underneath the policy update.`, row.id);
      return out;
    };
    if (!onNode) return { outcome: "stored", grant: await save(undefined, [row.state]) };

    let saved = await save("policy-pending: sending to the node", [row.state]);
    const station = await loadStation(deps.db, row.tenantId, row.stationId!);
    const params = VERB_PARAMS["forge.api.policy"].safeParse({
      stationId: station.id,
      grantId: row.id,
      preset: input.preset,
      rules: input.rules,
      allowGraphql: input.allowGraphql,
    });
    let why: string | null = null;
    if (!params.success) {
      why = "invalid policy frame; nothing was sent";
    } else {
      let res: BrokerReply | undefined;
      try {
        res = await deps.broker.request(station.nodeId, "forge.api.policy", params.data);
      } catch (err) {
        why = untrusted(scrub(err));
      }
      if (res && !res.ok) why = untrusted(res.error ?? "node error");
      if (res?.ok) {
        const ack = VERB_RESULTS["forge.api.policy"].safeParse(res.data);
        if (!ack.success) why = "unreadable policy reply";
        else if (ack.data.ok !== true) why = `node rejected the policy: ${untrusted(ack.data.error ?? "no reason given")}`;
      }
    }
    saved = await save(why ? `policy-pending: ${why}` : null, [saved.state]);
    if (why) log.warn("forge grant policy not applied on the node", { grantId: row.id, stationId: station.id, reason: why });
    return { outcome: why ? "pending" : "applied", grant: saved };
  });
}
