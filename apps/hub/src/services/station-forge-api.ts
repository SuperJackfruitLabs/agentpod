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
  ForgeApiVerifyReasons,
  type ForgeApiVerifyReason,
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
import { ForgeApiConfigError, ForgeApiGrantError } from "./forge-api/errors";
import { isConfiguredForge } from "./forge-api/instance";
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
  /**
   * The configured forge's URL (FORGE_URL). A minted grant's instance must be its origin, since the
   * token is minted there; absent means no minted grant is possible (fail closed).
   */
  forgeOrigin?: string | null;
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
  const minted = input.mode === "minted";
  // Pure checks first, before the station is even read: does the provider offer this mode, and a
  // minted token belongs to the configured forge only.
  const provider = deps.providers(input.provider);
  if (!provider.modes.includes(input.mode)) {
    throw new ForgeApiGrantError("mode-not-supported", `forge: ${input.provider} does not offer ${input.mode} grants.`);
  }
  if (minted && !isConfiguredForge(input.instance, deps.forgeOrigin)) {
    throw new ForgeApiConfigError(
      "instance-not-forge",
      "forge: a minted grant's instance must be this hub's configured forge (same https origin).",
    );
  }
  const station = await loadStation(deps.db, input.tenantId, input.stationId);

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
  // A delivered/verified grant is left alone unless it carries an unacknowledged live blob (an
  // ambiguous rotation delivery or a re-supplied credential): then that blob is re-sent.
  if ((row.state === "delivered" || row.state === "verified") && !blobIsLive(row, deps.now())) return row;
  if (row.state === "revoking" || row.state === "revoked") {
    throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id} is ${row.state}.`, row.id);
  }
  if (!row.stationId) {
    throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id}'s station is gone.`, row.id);
  }
  const station = await loadStation(deps.db, row.tenantId, row.stationId);
  const provider = deps.providers(row.provider);
  const blobLive = blobIsLive(row, deps.now());
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
  const now = deps.now();
  const blobLive = blobIsLive(row, now);
  if (blobLive) {
    return rotationOf(row).rotating ? sendRotationBlob(deps, row, station) : sendDeliver(deps, row, station, row.sealedBlob!);
  }
  if (row.state === "delivered" || row.state === "verified") return row;
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
  | { kind: "refused"; reason: string }
  /** The node answered, but unreadably: it may have stored the credential. */
  | { kind: "ambiguous"; reason: string };

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
  if (!ack.success) return { kind: "ambiguous", reason: "node acknowledged delivery with an unreadable reply" };
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
    // Outside a rotation an unreadable ack is never success: it fails like a refusal.
    const to: ForgeGrantState =
      out.kind === "refused" || out.kind === "ambiguous" ? "failed" : row.state === "delivered" || row.state === "verified" ? row.state : "provisioned";
    log.warn("forge grant not delivered", { grantId: row.id, stationId: station.id, state: to, reason: out.reason });
    return transition(deps.db, row, [row.state], to, { now: deps.now(), stateReason: out.reason });
  }
  const done = await transition(deps.db, row, [row.state], "delivered", {
    now: deps.now(),
    deliveredAt: deps.now(),
    // A newly stored credential is unverified, whatever the grant was before.
    verifiedAt: null,
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
//   grant cannot interleave: the second is `grant-busy`. Helpers below assume the claim is held.
// - **Frames are validated before `broker.request` and replies parsed with VERB_RESULTS**; only a
//   positive acknowledgement counts. Node offline/timeout is a typed outcome that changes nothing.
// - **Node text is untrusted**: a reason or login from the node is stripped of control characters
//   and capped at 200 characters before it is stored (`untrusted`).
// - **A live `sealed_blob` on a delivered/verified grant means the node has NOT acknowledged the
//   current credential** (an ambiguous rotation delivery, or a re-supplied credential whose relay
//   failed transiently). `deliverGrant` re-sends it, and `verifyGrant` re-sends it before verifying:
//   verifying without that could pass on the OLD credential (same account) and wrongly revoke it.
// - **Rotation (minted)** — `token_handle.previous` (disposition `live-until-verified`) is persisted
//   BEFORE the new token is minted. Then: mint → hub-side `checkToken` (identity of the new token)
//   → seal → deliver → node verify.
//   - PRE-ACK failure (mint, record, hub check, seal, a definitively refused deliver): the node is
//     untouched, so the new token is revoked (404 ok; if that fails it is kept as `orphan`), the row
//     goes back to the old handle and generation, reason `rotation-failed`, error `rotation-failed`.
//   - AMBIGUOUS (deliver transient/timeout — the node may have stored it): nothing is revoked; the
//     new token stays current with its sealed blob (24 h), state unchanged, reason
//     `rotation-pending`. `deliverGrant`/`verifyGrant` finish it.
//   - POST-ACK (the node stored it) and the verify is unreachable/inconclusive: nothing is
//     revoked; state `delivered` (so `verifyGrant` can retry), blob cleared (acked), reason
//     `rotation-pending`. A later matching `verifyGrant` revokes the old generation and clears
//     `previous`.
//   - POST-ACK and a definitive `wrong-identity`: the new token is revoked, the old one becomes
//     `previous` with disposition `revoke` (nobody holds it), state `failed`, reason
//     `rotation-failed`. The node holds a dead token either way; the grant needs a fresh mint.
// - **Revocation**: one UPDATE to `revoking`, then the node wipe FIRST (best effort; it cuts the
//   station's access at once), then the provider (minted: current, `previous`, `orphan`, 404 =
//   success; app: nothing, installation tokens expire; supplied: agentpod cannot, so
//   `revocation-pending-operator` until `confirmSuppliedRevoked`). `revoked` in one UPDATE once both
//   sides are done. What is outstanding is recorded in the reason as `; `-joined parts, provider
//   part first, and a retry does only those:
//     `provider-pending: …`            the provider revoke failed; retry
//     `revocation-pending-operator: …` supplied: the operator must revoke at the provider
//     `wipe-pending: …`                the node wipe has not been confirmed; retry (Task 8 reconnect)
//     `wipe-skipped: station-gone`     the station row is gone, so no node can be addressed
//   With the station gone and the provider side done the grant is `revoked` with reason
//   `revoked; node wipe skipped: station-gone (credential inert)`: a revoked-at-provider (or
//   expiring) credential on an unaddressable node is inert. A revoke never mints and never needs
//   the station key.
// - **Policy** is not a transition: the row's policy is updated in one UPDATE that keeps the state.
//   If the node cannot apply it the DB keeps the new policy (the next deliver frame carries it) and
//   the outcome is `policy-pending`. The reason says `policy-pending` ONLY when it was empty or
//   already a policy marker — a lifecycle reason (rotation-pending, wipe-pending, …) is never
//   overwritten. Task 8's reconcile re-sends the policy on reconnect / compares `forge.api.status`.
// - **The hub never opens a supplied/app blob**: it checks the envelope prefix and size and relays
//   it byte-identical.

/** Supplied/app sealed credentials are small: a PAT or an App key. Measured in characters. */
export const SUPPLIED_BLOB_MAX = 16 * 1024;

const NODE_REASON_MAX = 200;

/** A node-supplied string, safe to store: control characters removed, length capped. */
export function untrusted(s: unknown): string {
  const clean = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > NODE_REASON_MAX ? `${clean.slice(0, NODE_REASON_MAX)}…` : clean;
}

type Ref = { tenantId: string; grantId: string };
const toRef = (r: Ref): GrantRef => ({ tenantId: r.tenantId, id: r.grantId });

function isUnknownVerb(error: string): boolean {
  return /unknown verb/i.test(error);
}

const bareHandle = (h: ForgeTokenRef): ForgeTokenRef => (h.id === undefined ? { name: h.name } : { id: h.id, name: h.name });

const blobIsLive = (row: Grant, now: Date) =>
  !!row.sealedBlob && !!row.sealedExpiresAt && row.sealedExpiresAt.getTime() > now.getTime();

// ─── verify ───────────────────────────────────────────────────────────────────

/**
 * stk's verify reason codes (`ForgeApiVerifyReasons`, the first token of `reason`), mapped:
 * - definitive — the grant fails: unauthorized, forbidden, wrong-identity, repository-missing, and
 *   the misconfigurations redirect and unsupported;
 * - of those, `NEW_TOKEN_BAD` (unauthorized, wrong-identity) condemn a rotation's NEW token;
 * - transient — the PROVIDER could not be asked, state unchanged (`provider-unavailable`):
 *   unreachable, server-error, unexpected-response;
 * - any other code (a newer stk) — `inconclusive`, state unchanged.
 */
const VERIFY_DEFINITIVE = new Set<ForgeApiVerifyReason>([
  "unauthorized",
  "forbidden",
  "wrong-identity",
  "repository-missing",
  "redirect",
  "unsupported",
]);
const NEW_TOKEN_BAD = new Set<string>(["unauthorized", "wrong-identity"] satisfies ForgeApiVerifyReason[]);
const VERIFY_PROVIDER_DOWN = new Set<ForgeApiVerifyReason>(["unreachable", "server-error", "unexpected-response"]);
// Every stk code is mapped one way or the other.
ForgeApiVerifyReasons.forEach((r) => {
  if (!VERIFY_DEFINITIVE.has(r) && !VERIFY_PROVIDER_DOWN.has(r)) throw new Error(`forge: unmapped verify reason ${r}`);
});

type VerifyAnswer =
  | { kind: "ok"; login: string; isolation: "separate-user" | "same-user" }
  /** The grant fails. `code` is the definitive reason, `node-too-old`, or `verify-failed`. */
  | { kind: "failed"; code: string; reason: string }
  | { kind: "offline"; reason: string }
  | { kind: "provider-unavailable"; reason: string }
  /** The node answered no with a reason code the hub does not know: not evidence either way. */
  | { kind: "inconclusive"; reason: string };

/** Ask the node to make a real read call as the grant's credential. Writes nothing. */
async function askVerify(deps: ForgeApiDeps, row: Grant, station: { id: string; nodeId: string }): Promise<VerifyAnswer> {
  let expectLogin: string;
  try {
    expectLogin = expectLoginFor(deps, row);
  } catch (err) {
    return { kind: "failed", code: "verify-failed", reason: `verify-failed: ${scrub(err)}` };
  }
  const params = VERB_PARAMS["forge.api.verify"].safeParse({ stationId: station.id, grantId: row.id, expectLogin });
  if (!params.success) return { kind: "failed", code: "verify-failed", reason: "verify-failed: invalid verify frame; nothing was sent" };
  let res: BrokerReply;
  try {
    res = await deps.broker.request(station.nodeId, "forge.api.verify", params.data);
  } catch (err) {
    return { kind: "offline", reason: `verify not attempted: ${untrusted(scrub(err))}` };
  }
  if (!res.ok) {
    const error = untrusted(res.error ?? "node error");
    if (TRANSIENT.has(error)) return { kind: "offline", reason: `verify not attempted: ${error}` };
    if (isUnknownVerb(error)) {
      return { kind: "failed", code: "node-too-old", reason: "node-too-old: the node does not know forge.api.verify" };
    }
    return { kind: "failed", code: "verify-failed", reason: `verify-failed: ${error}` };
  }
  const parsed = VERB_RESULTS["forge.api.verify"].safeParse(res.data);
  if (!parsed.success) return { kind: "failed", code: "verify-failed", reason: "verify-failed: unreadable verify reply" };
  const r = parsed.data;
  if (r.ok !== true) {
    const text = untrusted(r.reason ?? "no reason given");
    const code = text.split(/[:\s]/)[0]!.toLowerCase();
    if (VERIFY_DEFINITIVE.has(code as ForgeApiVerifyReason)) return { kind: "failed", code, reason: code === "wrong-identity" ? text : `verify-failed: ${text}` };
    if (VERIFY_PROVIDER_DOWN.has(code as ForgeApiVerifyReason)) return { kind: "provider-unavailable", reason: `provider unavailable: ${text}` };
    return { kind: "inconclusive", reason: `verify inconclusive: ${text}` };
  }
  if (!r.login || r.login.toLowerCase() !== expectLogin.toLowerCase()) {
    return {
      kind: "failed",
      code: "wrong-identity",
      reason: `wrong-identity: expected ${untrusted(expectLogin)}, the forge answered as ${untrusted(r.login ?? "(nobody)")}`,
    };
  }
  return { kind: "ok", login: r.login, isolation: r.isolation };
}

export interface VerifyResult {
  /** rotation-failed: an interrupted or refused rotation was undone; the previous token is current again. */
  outcome: "verified" | "failed" | "node-offline" | "provider-unavailable" | "inconclusive" | "rotation-failed";
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

/** Is this row mid-rotation, and has the node acknowledged the NEW token? */
function rotationOf(row: Grant): { rotating: boolean; acked: boolean } {
  const rotating = row.tokenHandle?.previous?.disposition === "live-until-verified";
  // A rotation clears delivered_at when it starts and sets it only on a positive ack; the blob is
  // persisted before the frame goes out and cleared only on that ack. Both must say "acked".
  return { rotating, acked: rotating && row.deliveredAt !== null && !row.sealedBlob };
}

/**
 * PRE-ACK undo (claim held): the node never stored the new token, so it is revoked (404 ok; kept
 * as `orphan` if that fails) and the row returns to `previous` — its handle, generation and
 * delivered_at — with the blob cleared and reason `rotation-failed`. The node still holds n.
 */
async function restorePrevious(
  deps: ForgeApiDeps,
  row: Grant,
  why: string,
  current?: ForgeTokenRef,
  secret?: string,
): Promise<Grant> {
  const prev = row.tokenHandle!.previous!;
  const cur = current ?? bareHandle(row.tokenHandle!);
  const gone = await compensateRevoke(deps.providers(row.provider), row.account, cur, row.id, secret);
  const reason = `rotation-failed: ${why}`;
  const restored = await transition(deps.db, row, [row.state], row.state, {
    now: deps.now(),
    generation: prev.generation ?? row.generation,
    tokenHandle: gone ? bareHandle(prev) : { ...bareHandle(prev), orphan: cur },
    deliveredAt: prev.deliveredAt ? new Date(prev.deliveredAt) : null,
    sealed: null,
    stateReason: reason,
  });
  log.warn("forge grant rotation undone before delivery; the previous token stays live", { grantId: row.id, reason });
  return restored;
}

/**
 * Send a rotation's persisted blob (claim held). Ack → `delivered` (blob cleared, delivered_at
 * set, unverified). Transient or an unreadable ack → ambiguous: unchanged, blob kept,
 * `rotation-pending`. A definite refusal → `restorePrevious` (reason `rotation-failed`).
 */
async function sendRotationBlob(deps: ForgeApiDeps, row: Grant, station: StationRow): Promise<Grant> {
  const out = await relayDeliver(deps, row, station, row.sealedBlob!);
  if (out.kind === "refused") return restorePrevious(deps, row, out.reason);
  if (out.kind !== "acked") {
    log.warn("forge grant rotation delivery unconfirmed; nothing revoked", { grantId: row.id, stationId: station.id });
    return transition(deps.db, row, [row.state], row.state, { now: deps.now(), stateReason: `rotation-pending: ${out.reason}` });
  }
  const now = deps.now();
  return transition(deps.db, row, [row.state], "delivered", {
    now,
    deliveredAt: now,
    verifiedAt: null,
    isolation: out.isolation,
    sealed: null,
    stateReason: "rotation-pending: awaiting verification",
  });
}

/**
 * Apply a verify answer to the row (claim held).
 * - Match: `verified`; a `previous` is revoked (404 ok) and cleared — but during a rotation ONLY
 *   once the node acked the new token (before that a match may be n answering), else it is kept.
 * - Definitive failure after a rotation's ack: n is superseded (the node replaced it) so it is
 *   revoked now, best effort, else kept with disposition `revoke`; `unauthorized`/`wrong-identity`
 *   also revoke the NEW token (it is bad); `forbidden`/`repository-missing`/`redirect`/
 *   `unsupported` (configuration) do not. Grant `failed`, reason `rotation-failed`.
 * - Any other failure: `failed`, `previous` untouched. Offline/provider-down/inconclusive: unchanged.
 */
async function settleVerify(deps: ForgeApiDeps, row: Grant, answer: VerifyAnswer): Promise<VerifyResult> {
  const handle = row.tokenHandle;
  const prev = handle?.previous;
  const { rotating, acked } = rotationOf(row);
  switch (answer.kind) {
    case "offline":
      log.info("forge grant verify deferred: node unreachable", { grantId: row.id });
      return { outcome: "node-offline", grant: row };
    case "provider-unavailable":
    case "inconclusive":
      log.info("forge grant verify inconclusive", { grantId: row.id, reason: answer.reason });
      return { outcome: answer.kind, grant: row };
    case "failed": {
      if (acked && handle && prev) {
        const provider = deps.providers(row.provider);
        const { previous: _p, ...current } = handle;
        if (NEW_TOKEN_BAD.has(answer.code)) await compensateRevoke(provider, row.account, bareHandle(current), row.id);
        const nGone = await compensateRevoke(provider, row.account, bareHandle(prev), row.id);
        const reason = `rotation-failed: ${answer.reason}`;
        const grant = await transition(deps.db, row, [row.state], "failed", {
          now: deps.now(),
          tokenHandle: nGone ? current : { ...current, previous: { ...prev, disposition: "revoke" } },
          stateReason: reason,
        });
        log.warn("forge grant rotation failed after delivery", { grantId: row.id, reason });
        return { outcome: "failed", grant };
      }
      log.warn("forge grant failed verification", { grantId: row.id, reason: answer.reason });
      const grant = await transition(deps.db, row, [row.state], "failed", { now: deps.now(), stateReason: answer.reason });
      return { outcome: "failed", grant };
    }
    case "ok": {
      const now = deps.now();
      const revokePrev = !!prev && (!rotating || acked);
      let grant = await transition(deps.db, row, [row.state], "verified", {
        now,
        verifiedAt: now,
        isolation: answer.isolation,
        stateReason: revokePrev ? `verified; revoking ${prev!.name}` : rotating ? "rotation-pending: new token not acknowledged" : null,
      });
      if (revokePrev && handle) {
        const { previous: _p, ...rest } = handle;
        try {
          await revokeTolerant(deps.providers(row.provider), row.account, bareHandle(prev!));
          grant = await transition(deps.db, grant, ["verified"], "verified", { now: deps.now(), tokenHandle: rest, stateReason: null });
        } catch (err) {
          log.warn("forge grant verified but the previous token is not revoked yet", { grantId: row.id });
          grant = await transition(deps.db, grant, ["verified"], "verified", {
            now: deps.now(),
            tokenHandle: { ...rest, previous: { ...prev!, disposition: "revoke" } },
            stateReason: `previous-revoke-pending: ${scrub(err)}`,
          });
        }
      }
      log.info("forge grant verified", { grantId: row.id });
      return { outcome: "verified", grant };
    }
  }
}

/**
 * `forge.api.verify` with the provider's expected identity; see `askVerify` for the reason mapping
 * and `settleVerify` for what each answer does. A live unacknowledged blob is re-sent first (a
 * rotation's through `sendRotationBlob`). A rotation interrupted before its blob existed (the new
 * token was never sealed, so it can never reach the node) is undone: `rotation-failed`.
 */
export async function verifyGrant(deps: ForgeApiDeps, ref: Ref): Promise<VerifyResult> {
  const stale = await loadGrant(deps.db, toRef(ref));
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    let row = await loadGrant(deps.db, stale);
    assertVerifiable(row);
    if (!row.stationId) {
      throw new ForgeApiGrantError("grant-not-verifiable", `forge grant ${row.id}'s station is gone.`, row.id);
    }
    const station = await loadStation(deps.db, row.tenantId, row.stationId);
    const { rotating } = rotationOf(row);
    if (row.sealedBlob) {
      // The node has not acknowledged the current credential; verifying now could pass on the old.
      if (!blobIsLive(row, deps.now())) {
        throw new ForgeApiGrantError(
          "grant-not-verifiable",
          `forge grant ${row.id}: its current credential was never acknowledged and the sealed copy expired.`,
          row.id,
        );
      }
      row = rotating ? await sendRotationBlob(deps, row, station) : await sendDeliver(deps, row, station, row.sealedBlob);
      if (rotating && !row.tokenHandle?.previous) return { outcome: "rotation-failed", grant: row };
      if (row.sealedBlob) return { outcome: row.state === "failed" ? "failed" : "node-offline", grant: row };
    } else if (rotating && row.deliveredAt === null) {
      // Interrupted between mint and seal: no blob was ever made, so the new token cannot be
      // delivered and the node still holds n. Undo the rotation; n stays.
      const restored = await restorePrevious(deps, row, "interrupted before the new token was sealed");
      return { outcome: "rotation-failed", grant: restored };
    }
    return settleVerify(deps, row, await askVerify(deps, row, station));
  });
}

// ─── rotate (minted) ──────────────────────────────────────────────────────────

/**
 * Minted rotation; see the header for every outcome. Supplied and app grants rotate by the
 * operator supplying a new sealed credential (`acceptSuppliedSecret`).
 *
 * Returns the row: `verified` when finished, or `rotation-pending` (delivered or unchanged state)
 * when the node may hold the new token but has not verified it. Throws `rotation-failed` when the
 * rotation was taken back (pre-ack) or the new token was definitively the wrong identity. An
 * unreachable node is found before any mint (`station-key-unavailable`), changing nothing.
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
    if (row.tokenHandle.previous || row.tokenHandle.orphan || row.sealedBlob) {
      throw new ForgeApiGrantError(
        "grant-not-rotatable",
        `forge grant ${row.id} has an unfinished rotation or a token to revoke; finish that first.`,
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
  // Everything needed to put n back, kept in the jsonb so a crash loses none of it.
  const previous = {
    ...oldHandle,
    disposition: "live-until-verified" as const,
    generation: before.generation,
    deliveredAt: before.deliveredAt ? before.deliveredAt.toISOString() : null,
  };

  // 1. BEFORE minting: `previous`, the next generation's deterministic name, and delivered_at
  //    cleared (it is set again only by the node's ack of the new token).
  let row = await deps.db.transaction(async (tx) => {
    const generation = await nextGeneration(tx, before.tenantId, before.stationIdSnapshot, before.provider, before.instance);
    return transition(tx, before, [priorState], priorState, {
      now: deps.now(),
      generation,
      deliveredAt: null,
      tokenHandle: { name: tokenName({ id: before.id, generation }), previous },
      stateReason: `rotation-pending: minting generation ${generation}`,
    });
  });
  const newName = row.tokenHandle!.name;

  /** PRE-ACK: the node never took the new token. Undo, then report. */
  const abortPreAck = async (why: string, current: ForgeTokenRef, secret?: string): Promise<never> => {
    await restorePrevious(deps, row, why, current, secret);
    throw new ForgeApiGrantError("rotation-failed", `forge grant ${row.id}: rotation-failed: ${why}`, row.id);
  };

  // 2. Mint generation n+1. The token lives in `secret` until it is sealed.
  let minted: { id: number | undefined; name: string; secret: string };
  try {
    minted = await provider.mint!(row.account, {
      name: newName,
      scopes: provider.mintScopes(grantRef(row)),
      repositories: row.repositories.map(splitRepo),
    });
  } catch (err) {
    return abortPreAck(`mint failed: ${scrub(err)}`, { name: newName });
  }
  let secret: string | undefined = minted.secret;
  const newHandle: ForgeTokenRef = minted.id === undefined ? { name: minted.name } : { id: minted.id, name: minted.name };
  try {
    row = await transition(deps.db, row, [priorState], priorState, {
      now: deps.now(),
      tokenHandle: { ...newHandle, previous },
      stateReason: row.stateReason,
    });
  } catch (err) {
    const s = secret;
    secret = undefined;
    return abortPreAck(`the new token could not be recorded (${scrub(err, s)})`, newHandle, s);
  }

  // 3. Hub-side check: the forge must say the new token is the expected account.
  if (provider.checkToken) {
    let login: string;
    try {
      ({ login } = await provider.checkToken(row.account, secret));
    } catch (err) {
      const s = secret;
      secret = undefined;
      return abortPreAck(`the new token did not check out: ${scrub(err, s)}`, newHandle, s);
    }
    const expected = expectLoginFor(deps, row);
    if (login.toLowerCase() !== expected.toLowerCase()) {
      secret = undefined;
      return abortPreAck(`the new token belongs to ${untrusted(login)}, not ${expected}`, newHandle);
    }
  }

  // 4. Seal, and persist the blob in the UPDATE that follows sealing, BEFORE the frame goes out:
  //    from the moment n+1 can reach the node, "live blob" means "not acknowledged".
  let sealed: string;
  try {
    sealed = await deps.seal(publicKey, { token: secret });
  } catch (err) {
    const why = `seal failed: ${scrub(err, secret)}`;
    secret = undefined;
    return abortPreAck(why, newHandle);
  }
  secret = undefined;
  try {
    const now = deps.now();
    row = await transition(deps.db, row, [priorState], priorState, {
      now,
      sealed: { blob: sealed, expiresAt: new Date(now.getTime() + SEALED_BLOB_TTL_MS) },
      stateReason: "rotation-pending: delivering",
    });
  } catch (err) {
    return abortPreAck(`the sealed token could not be recorded (${scrub(err)})`, newHandle);
  }

  // 5. Deliver. Refused → undone (pre-ack); transient/unreadable → ambiguous, left pending.
  row = await sendRotationBlob(deps, row, station);
  if (!row.tokenHandle?.previous) {
    throw new ForgeApiGrantError("rotation-failed", `forge grant ${row.id}: ${row.stateReason}`, row.id);
  }
  if (row.sealedBlob) return row;

  // 6. POST-ACK: verify the new token on the node.
  const settled = await settleVerify(deps, row, await askVerify(deps, row, station));
  if (settled.outcome === "failed" && settled.grant.stateReason?.startsWith("rotation-failed")) {
    throw new ForgeApiGrantError("rotation-failed", `forge grant ${row.id}: ${settled.grant.stateReason}`, row.id);
  }
  if (settled.outcome === "verified") {
    log.info("forge grant rotated", { grantId: row.id, stationId: station.id, generation: settled.grant.generation });
    return settled.grant;
  }
  if (settled.outcome === "failed") return settled.grant;
  // Unverified for now: keep `rotation-pending` (plus why) so verifyGrant finishes it.
  return transition(deps.db, settled.grant, ["delivered"], "delivered", {
    now: deps.now(),
    stateReason: `rotation-pending: ${settled.outcome}`,
  });
}

// ─── revoke ───────────────────────────────────────────────────────────────────

export interface RevokeResult {
  /**
   * revoked: both sides done. pending: the provider revoke failed, retry. pending-operator: a
   * supplied credential the operator must revoke. wipe-pending: provider done, node wipe queued.
   */
  outcome: "revoked" | "pending" | "pending-operator" | "wipe-pending";
  grant: Grant;
}

const PROVIDER_PENDING = "provider-pending";
const PENDING_OPERATOR = "revocation-pending-operator";
const WIPE_PENDING = "wipe-pending";
const WIPE_SKIPPED = "wipe-skipped: station-gone";
export const REVOKED_STATION_GONE = "revoked; node wipe skipped: station-gone (credential inert)";

type WipeResult = { status: "done" } | { status: "skipped" } | { status: "pending"; why: string };

/** Ask the node to wipe its stk entry. */
async function wipeOnNode(deps: ForgeApiDeps, row: Grant): Promise<WipeResult> {
  if (!row.stationId) return { status: "skipped" };
  const [st] = await deps.db
    .select()
    .from(stations)
    .where(and(eq(stations.tenantId, row.tenantId), eq(stations.id, row.stationId)));
  if (!st) return { status: "skipped" };
  const params = VERB_PARAMS["forge.api.revoke"].safeParse({ stationId: st.id, grantId: row.id });
  if (!params.success) return { status: "pending", why: "invalid revoke frame" };
  let res: BrokerReply;
  try {
    res = await deps.broker.request(st.nodeId, "forge.api.revoke", params.data);
  } catch (err) {
    return { status: "pending", why: untrusted(scrub(err)) };
  }
  if (!res.ok) {
    const error = untrusted(res.error ?? "node error");
    return { status: "pending", why: isUnknownVerb(error) ? "node-too-old" : error };
  }
  // removed:false means there was nothing to remove: the entry is gone either way.
  if (!VERB_RESULTS["forge.api.revoke"].safeParse(res.data).success) return { status: "pending", why: "unreadable revoke reply" };
  return { status: "done" };
}

/**
 * One pass over a `revoking` grant (claim held): the outstanding sides only, wipe first, then the
 * provider; `revoked` when nothing is outstanding. `operatorConfirmed`: a supplied token the
 * operator says is revoked at the provider.
 */
async function revokePass(deps: ForgeApiDeps, row: Grant, operatorConfirmed: boolean): Promise<RevokeResult> {
  const reason = row.stateReason ?? "";
  const marked = [PROVIDER_PENDING, PENDING_OPERATOR, WIPE_PENDING, WIPE_SKIPPED].some((m) => reason.includes(m));
  // Unmarked (just entered, or moved to `revoking` by someone else): both sides are outstanding.
  const wipeNeeded = !marked || reason.includes(WIPE_PENDING);
  const providerNeeded = !marked || reason.includes(PROVIDER_PENDING) || reason.includes(PENDING_OPERATOR);
  let skipped = reason.includes(WIPE_SKIPPED);

  // 1. Node wipe first: it cuts the station's access at once, whatever the forge is doing.
  let wipePart: string | null = null;
  if (wipeNeeded) {
    const w = await wipeOnNode(deps, row);
    if (w.status === "skipped") skipped = true;
    if (w.status === "pending") wipePart = `${WIPE_PENDING}: ${w.why}`;
  }

  // 2. Provider.
  let providerPart: string | null = null;
  if (providerNeeded) {
    if (row.mode === "minted") {
      const provider = deps.providers(row.provider);
      const h = row.tokenHandle;
      const handles = [h, h?.previous, h?.orphan].filter((x): x is ForgeTokenRef => !!x).map(bareHandle);
      try {
        for (const x of handles) await revokeTolerant(provider, row.account, x);
      } catch (err) {
        providerPart = `${PROVIDER_PENDING}: ${scrub(err)}`;
        log.warn("forge grant revoke at the provider failed; will retry", { grantId: row.id, stationId: row.stationIdSnapshot });
      }
    } else if (row.mode === "supplied" && !operatorConfirmed) {
      providerPart = `${PENDING_OPERATOR}: the operator must revoke this token at the provider`;
    }
    // app: nothing to revoke — stk's installation tokens expire within about an hour. The operator
    // removes the App key on GitHub if the App itself should go.
  }

  // 3. Settle.
  if (!providerPart && !wipePart) {
    const grant = await transition(deps.db, row, ["revoking"], "revoked", {
      now: deps.now(),
      stateReason: skipped ? REVOKED_STATION_GONE : null,
    });
    log.info("forge grant revoked", { grantId: row.id, stationId: row.stationIdSnapshot, wipeSkipped: skipped });
    return { outcome: "revoked", grant };
  }
  const parts = [providerPart, wipePart, skipped ? WIPE_SKIPPED : null].filter((p): p is string => !!p);
  const grant = await transition(deps.db, row, ["revoking"], "revoking", { now: deps.now(), stateReason: parts.join("; ") });
  const outcome: RevokeResult["outcome"] = providerPart?.startsWith(PENDING_OPERATOR)
    ? "pending-operator"
    : providerPart
      ? "pending"
      : "wipe-pending";
  return { outcome, grant };
}

/**
 * Revoke a grant: `revoking`, node wipe first (best effort), then the provider, then `revoked`.
 * Re-entrant: calling it again on a `revoking` grant does only what its reason says is outstanding
 * (reconcile does this). Works with the station gone. Never mints, never needs the station key.
 */
export async function revokeGrant(deps: ForgeApiDeps, ref: Ref): Promise<RevokeResult> {
  const stale = await loadGrant(deps.db, toRef(ref));
  if (stale.state === "revoked") return { outcome: "revoked", grant: stale };
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    let row = await loadGrant(deps.db, stale);
    if (row.state === "revoked") return { outcome: "revoked", grant: row };
    if (row.state !== "revoking") {
      // One UPDATE; any undelivered blob goes with it. Both sides outstanding.
      const provider = row.mode === "supplied" ? PENDING_OPERATOR : PROVIDER_PENDING;
      row = await transition(deps.db, row, [row.state], "revoking", {
        now: deps.now(),
        stateReason: `${provider}; ${WIPE_PENDING}`,
        sealed: null,
      });
    }
    return revokePass(deps, row, false);
  });
}

/**
 * The operator confirms a supplied token is revoked at the provider. Completes the revocation,
 * retrying an outstanding node wipe first (a gone station skips it).
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
    return revokePass(deps, row, true);
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
      `forge: a supplied credential must be a ${STK_HANDOVER_PREFIX} envelope of at most ${SUPPLIED_BLOB_MAX} characters.`,
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
  /**
   * applied: the node confirmed. stored: the node has no credential yet; the next deliver carries
   * it. policy-pending: saved, the node has not confirmed (reconcile re-sends it).
   */
  outcome: "applied" | "stored" | "policy-pending";
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
 * apply it leaves the DB policy in place and returns `policy-pending` (not rolled back: the policy
 * is the operator's intent, and every later deliver frame carries it). The reason records
 * `policy-pending` only when it was empty or already a policy marker; a lifecycle reason
 * (rotation-pending, previous-revoke-pending, rotation-failed, …) is never overwritten — Task 8's
 * reconcile re-sends the policy on reconnect / compares `forge.api.status`. For a minted grant
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

    // Only our own marker may be written over; a lifecycle reason is left exactly as it is.
    const mayMark = row.stateReason === null || row.stateReason.startsWith("policy-pending");
    const mark = (r: string | null) => (mayMark ? r : undefined);
    let saved = await save(mark("policy-pending: sending to the node"), [row.state]);
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
    saved = await save(mark(why ? `policy-pending: ${why}` : null), [saved.state]);
    if (why) log.warn("forge grant policy not applied on the node", { grantId: row.id, stationId: station.id, reason: why });
    return { outcome: why ? "policy-pending" : "applied", grant: saved };
  });
}
