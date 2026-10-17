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
 * Every query is tenant-scoped. Only minted mode is implemented here; app and supplied modes are
 * refused with `mode-not-supported` until their tasks land.
 */
import {
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
   * Accepted for interface compatibility and IGNORED: the expected login is the account, and the
   * account is the station's occupant, never something a caller names.
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
  delivered: ["verified", "failed", "revoking"],
  verified: ["failed", "revoking"],
  // failed → provisioned: a retry; failed → failed: a retry that failed again.
  failed: ["provisioned", "failed", "revoking"],
  revoking: ["revoking", "revoked", "failed"],
  // A tombstone is final.
  revoked: [],
};

export interface TransitionPatch {
  now: Date;
  /** Always written: a successful step clears the previous reason. */
  stateReason?: string | null;
  tokenHandle?: { id?: number; name: string } | null;
  generation?: number;
  isolation?: "separate-user" | "same-user" | null;
  deliveredAt?: Date | null;
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
async function revokeTolerant(provider: ForgeProvider, account: string, handle: { id?: number; name: string }) {
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
  handle: { id?: number; name: string },
  grantId: string,
  secret?: string,
): Promise<void> {
  try {
    await revokeTolerant(provider, account, handle);
  } catch (err) {
    log.warn("forge compensating revoke failed; reconcile will find the token by name", {
      grantId,
      tokenName: handle.name,
      error: scrub(err, secret),
    });
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
async function withGrantClaim<T>(tenantId: string, grantId: string, fn: () => Promise<T>): Promise<T> {
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

  // The account is the occupant's handle. Nothing in `input` can name it.
  const principalId = station.principalId;
  const account = principalId ? await principalHandle(principalId) : null;
  if (!principalId || !account) {
    throw new ForgeApiGrantError("no-occupant", `station ${station.id} has no occupant to grant forge access to.`);
  }
  if (!(station.capabilities ?? []).includes("forge.api")) {
    throw new ForgeApiGrantError("capability-missing", `station ${station.id}'s node does not support forge.api; update the node.`);
  }
  if (input.mode !== "minted") {
    throw new ForgeApiGrantError("mode-not-supported", `forge: ${input.mode} grants are not supported yet.`);
  }
  for (const repo of input.repositories) {
    try {
      splitRepo(repo);
    } catch (err) {
      throw new ForgeApiGrantError("bad-repository", scrub(err));
    }
  }
  const provider = deps.providers(input.provider);
  // Scope check up front: a config mistake (preset "none", …) is a 422 before any row or token.
  provider.mintScopes({
    id: "pending",
    provider: input.provider,
    instance: input.instance,
    mode: input.mode,
    account,
    expectedLogin: account,
    preset: input.preset,
    repositories: input.repositories,
    generation: 1,
  });

  // BEFORE any mint: no key means no seal, and a token that cannot be sealed is an orphan.
  const publicKey = await stationPublicKey(deps, station);

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

async function sendDeliver(deps: ForgeApiDeps, row: Grant, station: StationRow, sealed: string): Promise<Grant> {
  const fail = async (to: "provisioned" | "failed", reason: string) => {
    log.warn("forge grant not delivered", { grantId: row.id, stationId: station.id, state: to, reason });
    return transition(deps.db, row, [row.state], to, { now: deps.now(), stateReason: reason });
  };

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
    expectLogin: row.expectedLogin ?? row.account,
  });
  if (!frame.success) {
    // Paths only, never values: a value could be the blob.
    const where = frame.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    return fail("failed", `invalid deliver frame (${where}); nothing was sent`);
  }

  let res: BrokerReply;
  try {
    res = await deps.broker.request(station.nodeId, "forge.api.deliver", frame.data);
  } catch (err) {
    return fail("provisioned", `delivery not attempted: ${scrub(err, sealed)}`);
  }
  if (!res.ok) {
    const error = scrub(res.error ?? "node error", sealed);
    return TRANSIENT.has(error)
      ? fail("provisioned", `delivery failed: ${error}; will retry`)
      : fail("failed", `node refused delivery: ${error}`);
  }
  const ack = VERB_RESULTS["forge.api.deliver"].safeParse(res.data);
  // A failed or unreadable ack keeps the sealed blob by design: it is ciphertext only the node can
  // open, it expires after 24 h, and keeping it lets a retry re-send instead of re-minting.
  if (!ack.success) return fail("failed", "node acknowledged delivery with an unreadable reply");
  if (ack.data.ok !== true || ack.data.stored !== true) {
    return fail("failed", `node did not confirm the token was stored (ok=${ack.data.ok}, stored=${ack.data.stored})`);
  }
  const done = await transition(deps.db, row, [row.state], "delivered", {
    now: deps.now(),
    deliveredAt: deps.now(),
    isolation: ack.data.isolation,
    sealed: null,
  });
  log.info("forge grant delivered", { grantId: row.id, stationId: station.id, isolation: ack.data.isolation });
  return done;
}
