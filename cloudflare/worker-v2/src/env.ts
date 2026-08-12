/**
 * The sandbox environment, split by who owns each variable.
 *
 * A container's environment does not survive a stop, so this worker has to hand
 * it back on every start. It used to do that by writing the whole map to Durable
 * Object storage at creation and replaying it verbatim on each wake — which
 * froze it. `AGENTPOD_SNAPSHOT_URL` and `AGENTPOD_SNAPSHOT_TOKEN`, added on
 * 2026-08-12 05:53Z, therefore reached sandboxes created *after* that deploy and
 * no others; runtime rt_aa47bc04ed34443796bc, created 72 minutes earlier, ran on
 * looking perfectly healthy while `snapshot-wrapper.sh` skipped both restore and
 * archive and dropped the workspace on every sleep (#253).
 *
 * The fix is the split below, and it is deliberately EXPLICIT: the next person
 * adding a variable has to put it on one side or the other.
 *
 *   caller-owned    — minted by the hub at create time and unknowable to this
 *                     worker afterwards. Stored, and replayed verbatim forever.
 *   substrate-owned — facts about where this worker is and what it minted.
 *                     Re-derived on EVERY start and never persisted, so a
 *                     worker-side change reaches existing sandboxes on their
 *                     next start instead of only new ones.
 *
 * If you cannot recompute a value from the request and DO storage, it is
 * caller-owned. If you can, it is substrate-owned — persisting it buys nothing
 * and costs you this bug again.
 */

/** DO storage key for the caller-owned environment. */
export const ENV_KEY = "envVars";

/** DO storage key for the per-sandbox snapshot token. */
export const SNAPSHOT_TOKEN_KEY = "snapshotToken";

/**
 * Variables this worker owns and re-derives at every start.
 *
 * Adding a key here is a compile-time obligation: `substrateEnv` returns a
 * record keyed by this list, so the build fails until the key is derived.
 */
export const SUBSTRATE_OWNED_KEYS = [
  // Where the entrypoint archives and restores /workspace. Derived from the
  // origin of the request that started the container, so the worker never has
  // to be told its own URL — and so moving it does not strand old sandboxes.
  "AGENTPOD_SNAPSHOT_URL",
  // Minted per sandbox by this worker, kept in DO storage, never told to anyone
  // but the container it belongs to.
  "AGENTPOD_SNAPSHOT_TOKEN",
] as const;

export type SubstrateKey = (typeof SUBSTRATE_OWNED_KEYS)[number];

/**
 * Variables the caller owns. Listed for the reader, not enforced: an unlisted
 * key from the hub is kept as caller-owned, which is the safe default — the
 * unsafe default is silently freezing something this worker could recompute.
 */
export const CALLER_OWNED_KEYS = [
  "AGENTPOD_HUB_URL",
  "AGENTPOD_ENROLL_TOKEN",
  "AGENTPOD_RUNTIME_ID",
  "AGENTPOD_RUNTIME_CALLBACK_TOKEN",
] as const;

/** The slice of Durable Object storage this module needs. */
export interface EnvStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/**
 * What the substrate knows at the moment of a start.
 *
 * `origin` comes from the request being served — NOT from storage. Storing it
 * at creation would re-create the very bug this module exists for, one level
 * down: the sandboxes that need healing are precisely the ones with nothing
 * stored, and a worker that moves hostname would freeze the old one forever.
 */
export interface SubstrateContext {
  origin: string;
  sandboxId: string;
}

/** The per-sandbox snapshot token, minted on first use and kept thereafter. */
export async function snapshotToken(storage: EnvStorage): Promise<string> {
  const existing = await storage.get<string>(SNAPSHOT_TOKEN_KEY);
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await storage.put(SNAPSHOT_TOKEN_KEY, token);
  return token;
}

/** The substrate-owned half of the environment, as of right now. */
export function substrateEnv(
  ctx: SubstrateContext,
  token: string
): Record<SubstrateKey, string> {
  return {
    AGENTPOD_SNAPSHOT_URL: `${ctx.origin}/sandbox/${ctx.sandboxId}/snapshot`,
    AGENTPOD_SNAPSHOT_TOKEN: token,
  };
}

/** Everything the worker cannot recompute — i.e. what is worth persisting. */
export function callerOwned(env: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if ((SUBSTRATE_OWNED_KEYS as readonly string[]).includes(key)) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * Merge stored caller-owned values with freshly derived substrate-owned ones.
 *
 * The substrate half goes last on purpose: a stale value in an old stored map
 * must lose to the current one.
 */
async function merge(
  storage: EnvStorage,
  ctx: SubstrateContext,
  stored: Record<string, string>
): Promise<Record<string, string>> {
  return {
    ...callerOwned(stored),
    ...substrateEnv(ctx, await snapshotToken(storage)),
  };
}

/**
 * The environment for a NEW sandbox: persist the caller-owned half, then start
 * from the same merge a wake would produce.
 *
 * Create and wake share this path deliberately. Two paths would drift, and
 * drift between them is exactly how a variable ends up reaching new sandboxes
 * only.
 */
export async function createStartEnv(
  storage: EnvStorage,
  ctx: SubstrateContext,
  callerEnv: Record<string, string>
): Promise<Record<string, string>> {
  const stored = callerOwned(callerEnv);
  await storage.put(ENV_KEY, stored);
  return merge(storage, ctx, stored);
}

/**
 * The environment for waking an EXISTING sandbox.
 *
 * Throws when nothing was ever stored rather than starting a container that
 * cannot enrol: a restart loop is far worse than a failed request, because it
 * is silent and it bills.
 */
export async function storedStartEnv(
  storage: EnvStorage,
  ctx: SubstrateContext
): Promise<Record<string, string>> {
  const stored = await storage.get<Record<string, string>>(ENV_KEY);
  if (!stored) {
    throw new Error("no stored environment for this sandbox; create it first");
  }
  return merge(storage, ctx, stored);
}
